import * as path from 'path';
import type { ImpactReport, WorkspaceTestProject } from './analyzerProtocol';
import type { CoverageParticipant } from './coverage';
import type { ExecutorProgress, ProjectOutcome, RunOutcome } from './executor';
import { RpcError } from './jsonRpc';
import { formatDuration, type Logger } from './logger';
import { locateTest } from './testLocator';
import { firstStackLines, type TestMethodResult } from './trx';
import { buildPlan, describeFallback, FailedTests, PendingWork, type ProjectPlan, type StateStore } from './work';

/** What the orchestrator needs from the analyzer (AnalyzerHost in the extension, fakes in tests). */
export interface ImpactSource {
  impact(files: readonly string[]): Promise<ImpactReport>;
  readonly testProjects: WorkspaceTestProject[] | undefined;
  whenReady(): Promise<unknown>;
}

export interface PlanRunner {
  execute(plans: readonly ProjectPlan[], signal: AbortSignal, progress: (p: ExecutorProgress) => void): Promise<RunOutcome>;
}

export type Phase = 'idle' | 'analyzing' | 'restoring' | 'building' | 'testing' | 'done' | 'waitingForDebug' | 'paused' | 'error';

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** Projects whose build failed. */
  buildFailed: string[];
  /** Projects whose restore or test run failed (no results). */
  runFailed: string[];
  /** Nothing was selected and nothing failed before. */
  noTests: boolean;
  /** First save of the cycle (or the Run All command) to the result. */
  durationMs: number;
}

export interface OrchestratorStatus {
  phase: Phase;
  /** Project being restored or built. */
  project?: string;
  /** Number of selected tests being run (undefined when whole projects run). */
  tests?: number;
  /** Last completed run. */
  summary?: RunSummary;
  /** Fallback reasons of the current or last plan. */
  fallbackReasons: string[];
  message?: string;
}

/** One entry of the last selection (for the "Why?" command). */
export interface SelectionEntry {
  project: string;
  projectName: string;
  mode: 'all' | 'filter';
  reasons: string[];
  test?: ProjectPlan['tests'][number];
  outcome?: TestMethodResult['outcome'];
}

export type Gate = 'debug' | 'paused';

export interface OrchestratorDependencies {
  analyzer: ImpactSource;
  executor: PlanRunner;
  state: StateStore;
  logger: Logger;
  debounceMs: () => number;
  /** New-code coverage (M4): extra selections for saved files and follow-ups after runs. */
  coverage?: CoverageParticipant;
  now?: () => number;
}

const WORK_KEY = 'aftershock.pendingWork';

/** A report without changed sources, build inputs, tests or fallbacks. */
export function isNoOp(report: ImpactReport): boolean {
  return (
    (report.tests ?? []).length === 0 &&
    !report.fallback &&
    (report.changedFiles ?? []).every((file) => file.analysis === 'ignored')
  );
}
const FAILED_KEY = 'aftershock.failedTests';
const SELECTION_KEY = 'aftershock.lastSelection';

/**
 * The save -> analyze -> build -> test loop. Saves are collected and debounced; every successful
 * `impact` result is merged into the pending work (also one for a superseded request: its snapshot
 * advanced, so its tests would otherwise be lost); a new save cancels the running build/test; work
 * leaves the pending set only after its tests ran.
 */
export class Orchestrator {
  private readonly pendingFiles = new Set<string>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private analysesInFlight = 0;
  private readonly work: PendingWork;
  readonly failed: FailedTests;
  private workGeneration = 0;
  private attemptedGeneration = 0;
  private job: { controller: AbortController; promise: Promise<void> } | undefined;
  private readonly gates = new Set<Gate>();
  private statusValue: OrchestratorStatus = { phase: 'idle', fallbackReasons: [] };
  private cycleStartedAt: number | undefined;
  private lastSummary: RunSummary | undefined;
  private selection: SelectionEntry[];
  private disposed = false;
  private readonly statusListeners: ((status: OrchestratorStatus) => void)[] = [];
  private readonly runListeners: ((outcome: RunOutcome) => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: OrchestratorDependencies) {
    this.now = deps.now ?? Date.now;
    this.work = PendingWork.fromJSON(deps.state.get(WORK_KEY));
    this.failed = FailedTests.fromJSON(deps.state.get(FAILED_KEY));
    this.selection = deps.state.get<SelectionEntry[]>(SELECTION_KEY) ?? [];
    if (!this.work.isEmpty) {
      // Work left over from the last session: run it with the next save.
      deps.logger.info(`Pending work from the last session: ${this.work.snapshot().map((p) => p.name).join(', ')}; it runs with the next save.`);
    }
  }

  get status(): OrchestratorStatus {
    return this.statusValue;
  }

  get lastSelection(): readonly SelectionEntry[] {
    return this.selection;
  }

  get isBusy(): boolean {
    return this.job !== undefined || this.analysesInFlight > 0 || this.debounceTimer !== undefined;
  }

  get isPaused(): boolean {
    return this.gates.has('paused');
  }

  onStatus(listener: (status: OrchestratorStatus) => void): void {
    this.statusListeners.push(listener);
  }

  onRunCompleted(listener: (outcome: RunOutcome) => void): void {
    this.runListeners.push(listener);
  }

  /** Saved files (absolute paths). */
  onSaved(files: readonly string[]): void {
    if (this.disposed || files.length === 0) {
      return;
    }
    files.forEach((file) => this.pendingFiles.add(file));
    this.cycleStartedAt ??= this.now();
    if (this.job) {
      this.deps.logger.info('A new save cancels the running build/test; its tests stay pending.');
      this.job.controller.abort();
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => void this.flush(), Math.max(0, this.deps.debounceMs()));
    this.setStatus({ phase: 'analyzing' });
  }

  /** Runs every test of every test project. */
  async runAll(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.job?.controller.abort();
    let projects = this.deps.analyzer.testProjects;
    if (!projects) {
      this.setStatus({ phase: 'analyzing' });
      try {
        await this.deps.analyzer.whenReady();
        projects = this.deps.analyzer.testProjects;
      } catch (error) {
        this.fail(`Run All Tests needs the analyzer's list of test projects: ${(error as Error).message}`);
        return;
      }
    }
    if (!projects || projects.length === 0) {
      this.deps.logger.warn('Run All Tests: the solution has no test projects.');
      this.setStatus({ phase: 'done', summary: this.lastSummary, message: 'no test projects' });
      return;
    }
    this.deps.logger.info(`Run All Tests: ${projects.length} test project(s).`);
    this.cycleStartedAt = this.now();
    this.work.addAll(projects, 'Run All Tests');
    this.workGeneration++;
    await this.persist();
    this.maybeStartRun();
  }

  setGate(gate: Gate, active: boolean): void {
    if (active === this.gates.has(gate)) {
      return;
    }
    if (active) {
      this.gates.add(gate);
      if (this.job) {
        this.deps.logger.info(gate === 'debug' ? 'A debug session started; cancelling the running build/test until it ends.' : 'Paused; cancelling the running build/test.');
        this.job.controller.abort();
      }
      if (!this.isBusy || this.job) {
        this.setStatus({ phase: this.gatePhase()! });
      }
    } else {
      this.gates.delete(gate);
      if (gate === 'debug') {
        this.deps.logger.info('The debug session ended.');
      }
      if (!this.isBusy) {
        this.restIdle();
      }
      this.maybeStartRun();
    }
  }

  /**
   * Adds the result of an extra analysis (coverage follow-up, Recompute New-Code Coverage) to the pending
   * work and runs it. Resolves to whether anything was added.
   */
  enqueue(label: string, producer: () => Promise<ImpactReport | undefined>, options: { showAnalyzing?: boolean } = {}): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    this.analysesInFlight++;
    if (options.showAnalyzing) {
      this.setStatus({ phase: 'analyzing' });
    }
    return (async () => {
      let added = false;
      const started = this.now();
      try {
        const report = await producer();
        if (report && !isNoOp(report)) {
          this.cycleStartedAt ??= started;
          this.logReport(report, [], this.now() - started, label);
          this.work.mergeReport(report);
          this.workGeneration++;
          await this.persist();
          added = true;
        } else if (report) {
          this.deps.logger.info(`${label}: no tests to run.`);
        }
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        this.deps.logger.warn(`${label} failed: ${message}`);
      } finally {
        this.analysesInFlight--;
        this.maybeStartRun();
      }
      return added;
    })();
  }

  /** Resolves when the current debounce, analyses and job have finished (tests, e2e). */
  async whenIdle(): Promise<void> {
    while (this.isBusy) {
      await (this.job?.promise ?? new Promise((resolve) => setTimeout(resolve, 25)));
    }
  }

  /** Stops everything; resolves when a running build/test has been killed (bounded by the caller). */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    const job = this.job;
    job?.controller.abort();
    return job ? job.promise : Promise.resolve();
  }

  // ---------------------------------------------------------------------------------------------

  private gatePhase(): Phase | undefined {
    return this.gates.has('debug') ? 'waitingForDebug' : this.gates.has('paused') ? 'paused' : undefined;
  }

  private setStatus(status: Partial<OrchestratorStatus> & { phase: Phase }): void {
    this.statusValue = { fallbackReasons: this.statusValue.fallbackReasons, summary: this.lastSummary, ...status };
    for (const listener of this.statusListeners) {
      listener(this.statusValue);
    }
  }

  private restIdle(): void {
    const gate = this.gatePhase();
    if (gate) {
      this.setStatus({ phase: gate });
    } else if (this.lastSummary) {
      this.setStatus({ phase: 'done', summary: this.lastSummary });
    } else {
      this.setStatus({ phase: 'idle' });
    }
  }

  private fail(message: string): void {
    this.deps.logger.error(message);
    this.setStatus({ phase: 'error', message });
  }

  private async persist(): Promise<void> {
    await this.deps.state.update(WORK_KEY, this.work.toJSON());
    await this.deps.state.update(FAILED_KEY, this.failed.toJSON());
    await this.deps.state.update(SELECTION_KEY, this.selection);
  }

  private async flush(): Promise<void> {
    this.debounceTimer = undefined;
    if (this.disposed) {
      return;
    }
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();
    if (files.length === 0) {
      this.maybeStartRun();
      return;
    }
    this.analysesInFlight++;
    this.setStatus({ phase: 'analyzing' });
    const started = this.now();
    try {
      const report = await this.deps.analyzer.impact(files);
      if (isNoOp(report)) {
        // Unchanged saves and files that are neither sources nor build inputs: nothing to run.
        this.deps.logger.debug(`Nothing relevant changed in ${files.map((f) => path.basename(f)).join(', ')}.`);
      } else {
        this.logReport(report, files, this.now() - started);
        this.work.mergeReport(report);
        this.workGeneration++;
        await this.persist();
      }
    } catch (error) {
      if (error instanceof RpcError && error.isCancellation) {
        // Superseded by a newer save: the analyzer keeps the files pending and reports them with it.
        this.deps.logger.debug(`Impact request ${error.cancelReason ?? 'cancelled'}; its files are part of the next analysis.`);
      } else {
        const message = (error as Error).message ?? String(error);
        const projects = this.deps.analyzer.testProjects;
        if (projects && projects.length > 0) {
          this.deps.logger.error(`Impact analysis failed (${message}); running all ${projects.length} test project(s) to be safe.`);
          this.work.addAll(projects, `analysis failed: ${message}`);
          this.workGeneration++;
          await this.persist();
        } else {
          this.analysesInFlight--;
          this.fail(`Impact analysis failed: ${message}`);
          this.maybeStartRun();
          return;
        }
      }
    }
    await this.coverageForSaved(files);
    this.analysesInFlight--;
    this.maybeStartRun();
  }

  /**
   * With coverage on, the run must include the tests of every member of the saved files that is new
   * relative to the target branch, not only of the latest edit (DESIGN.md 7.4).
   */
  private async coverageForSaved(files: readonly string[]): Promise<void> {
    const coverage = this.deps.coverage;
    if (!coverage || this.disposed) {
      return;
    }
    const started = this.now();
    try {
      const report = await coverage.impactForSaved(files);
      if (report && !isNoOp(report)) {
        this.logReport(report, files, this.now() - started, 'All new code (coverage) of');
        this.work.mergeReport(report);
        this.workGeneration++;
        await this.persist();
      }
    } catch (error) {
      if (error instanceof RpcError && error.isCancellation) {
        this.deps.logger.debug(`Coverage analysis ${error.cancelReason ?? 'cancelled'}.`);
        return;
      }
      const message = (error as Error).message ?? String(error);
      this.deps.logger.warn(
        `New-code coverage: analyzing all new code of ${files.map((f) => path.basename(f)).join(', ')} failed (${message}); their coverage stays unknown until they are saved again or recomputed.`,
      );
    }
  }

  private maybeStartRun(): void {
    if (this.disposed || this.debounceTimer || this.pendingFiles.size > 0 || this.analysesInFlight > 0 || this.job) {
      return;
    }
    if (this.workGeneration <= this.attemptedGeneration) {
      if (this.statusValue.phase === 'analyzing') {
        this.restIdle();
      }
      return;
    }
    const gate = this.gatePhase();
    if (gate) {
      if (gate === 'waitingForDebug') {
        this.deps.logger.info('Waiting for the debug session to end before building.');
      }
      this.setStatus({ phase: gate });
      return;
    }
    this.startJob();
  }

  private startJob(): void {
    const generation = this.workGeneration;
    this.attemptedGeneration = generation;
    const plans = buildPlan(this.work.snapshot(), this.failed.all());
    const fallbackReasons = [...new Set(plans.flatMap((p) => p.reasons))];
    this.selection = plans.flatMap((plan): SelectionEntry[] => {
      const base = { project: plan.path, projectName: plan.name, mode: plan.mode, reasons: plan.reasons };
      return plan.tests.length > 0 ? plan.tests.map((test) => ({ ...base, test })) : [base];
    });

    if (plans.length === 0) {
      const summary: RunSummary = { passed: 0, failed: 0, skipped: 0, total: 0, buildFailed: [], runFailed: [], noTests: true, durationMs: this.now() - (this.cycleStartedAt ?? this.now()) };
      this.cycleStartedAt = undefined;
      this.lastSummary = summary;
      this.deps.logger.info('No impacted tests.');
      this.statusValue = { ...this.statusValue, fallbackReasons: [] };
      this.setStatus({ phase: 'done', summary });
      void this.persist();
      return;
    }

    this.logPlan(plans);
    this.statusValue = { ...this.statusValue, fallbackReasons };
    const controller = new AbortController();
    const promise = (async () => {
      const outcome = await this.deps.executor.execute(plans, controller.signal, (p) => this.onProgress(p));
      if (outcome.cancelled) {
        this.deps.logger.info(`Build/test cancelled after ${formatDuration(outcome.durationMs)}; the selection stays pending.`);
        // Run it again as soon as nothing blocks (the next save, the end of a debug session, resume).
        this.attemptedGeneration = Math.min(this.attemptedGeneration, generation - 1);
        return;
      }
      await this.apply(outcome);
      const followUp = this.deps.coverage?.takeFollowUp();
      if (followUp && !this.disposed) {
        // Counted as an analysis in flight right away, so the run does not look finished meanwhile.
        void this.enqueue('Coverage follow-up', followUp);
      }
    })()
      .catch((error: Error) => {
        this.fail(`The run failed: ${error.message}`);
      })
      .finally(() => {
        this.job = undefined;
        if (!this.disposed) {
          if (!this.isBusy && this.workGeneration <= this.attemptedGeneration && (this.statusValue.phase === 'restoring' || this.statusValue.phase === 'building' || this.statusValue.phase === 'testing')) {
            this.restIdle();
          }
          this.maybeStartRun();
        }
      });
    this.job = { controller, promise };
  }

  private onProgress(progress: ExecutorProgress): void {
    switch (progress.phase) {
      case 'restoring':
        this.setStatus({ phase: 'restoring', project: progress.project });
        break;
      case 'building':
        this.setStatus({ phase: 'building', project: progress.project });
        break;
      case 'testing':
        this.setStatus({ phase: 'testing', tests: progress.tests });
        break;
    }
  }

  private async apply(outcome: RunOutcome): Promise<void> {
    const log = this.deps.logger;
    const resultByTest = new Map<string, TestMethodResult['outcome']>();
    for (const project of outcome.projects) {
      if (project.status !== 'passed' && project.status !== 'failed') {
        continue;
      }
      this.applyProject(project);
      for (const result of project.results) {
        resultByTest.set(`${project.plan.path}::${result.fullyQualifiedName}`, result.outcome);
      }
    }
    for (const entry of this.selection) {
      if (entry.test) {
        entry.outcome = resultByTest.get(`${entry.project}::${entry.test.fullyQualifiedName}`);
      }
    }

    const ran = outcome.projects.filter((p) => p.status === 'passed' || p.status === 'failed');
    const results = ran.flatMap((p) => p.results);
    const summary: RunSummary = {
      passed: results.filter((r) => r.outcome === 'passed').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      total: results.length,
      buildFailed: outcome.projects.filter((p) => p.status === 'buildFailed').map((p) => p.plan.name),
      runFailed: outcome.projects.filter((p) => p.status === 'restoreFailed' || p.status === 'testRunFailed').map((p) => p.plan.name),
      noTests: false,
      durationMs: this.now() - (this.cycleStartedAt ?? this.now()),
    };
    this.cycleStartedAt = undefined;
    this.lastSummary = summary;
    await this.persist();

    const problems = [...summary.buildFailed.map((n) => `build of ${n} failed`), ...summary.runFailed.map((n) => `${n} could not run`)];
    log.info(
      `Done in ${formatDuration(summary.durationMs)} (save to result): ${summary.passed} passed, ${summary.failed} failed` +
        `${summary.skipped ? `, ${summary.skipped} skipped` : ''}${problems.length ? `; ${problems.join('; ')}` : ''}.`,
    );
    for (const test of results.filter((r) => r.outcome === 'failed')) {
      log.info(`  FAILED ${test.fullyQualifiedName}${test.cases > 1 ? ` (${test.failedCases}/${test.cases} cases)` : ''}: ${(test.message ?? '').split(/\r?\n/)[0]}`);
    }
    this.setStatus({ phase: 'done', summary });
    for (const listener of this.runListeners) {
      listener(outcome);
    }
  }

  private applyProject(project: ProjectOutcome): void {
    const plan = project.plan;
    const log = this.deps.logger;
    this.work.removeExecuted({ path: plan.path, all: plan.mode === 'all', tests: plan.tests.filter((t) => t.origin === 'selected') });

    const results = new Map(project.results.map((r) => [r.fullyQualifiedName, r]));
    for (const result of project.results) {
      if (result.outcome === 'failed') {
        const planned = plan.tests.find((t) => t.fullyQualifiedName === result.fullyQualifiedName);
        const previous = this.failed.get(plan.path, result.fullyQualifiedName);
        const known = planned?.file && planned.line ? { file: planned.file, line: planned.line } : previous?.file && previous.line ? { file: previous.file, line: previous.line } : undefined;
        const location = locateTest({
          className: result.className,
          methodName: result.methodName,
          known,
          stackTrace: result.stackTrace,
          projectDirectory: path.dirname(plan.path),
        });
        this.failed.upsert({
          project: plan.path,
          projectName: plan.name,
          fullyQualifiedName: result.fullyQualifiedName,
          className: result.className,
          methodName: result.methodName,
          framework: planned?.framework ?? previous?.framework ?? plan.frameworks[0],
          parameterized: planned?.parameterized ?? previous?.parameterized ?? result.cases > 1,
          file: location?.file,
          line: location?.line,
          message: result.message,
          stackTrace: firstStackLines(result.stackTrace, 12).join('\n') || undefined,
          failedCase: result.failedCase,
          cases: result.cases,
          failedCases: result.failedCases,
        });
      } else if (this.failed.remove(plan.path, result.fullyQualifiedName)) {
        log.info(`  ${result.fullyQualifiedName} passes again.`);
      }
    }
    for (const test of plan.tests) {
      if (!results.has(test.fullyQualifiedName)) {
        if (test.origin === 'previouslyFailed') {
          if (this.failed.remove(plan.path, test.fullyQualifiedName)) {
            log.info(`  ${test.fullyQualifiedName} failed before but did not run now (removed or filtered out); forgetting it.`);
          }
        } else {
          log.debug(`  no result for ${test.fullyQualifiedName} (not discovered, or excluded by aftershock.testFilter)`);
        }
      }
    }
    if (plan.mode === 'all') {
      for (const stale of this.failed.forProject(plan.path)) {
        if (!results.has(stale.fullyQualifiedName)) {
          this.failed.remove(plan.path, stale.fullyQualifiedName);
        }
      }
    }
  }

  private logReport(report: ImpactReport, files: readonly string[], elapsedMs: number, label = 'Impact of'): void {
    const log = this.deps.logger;
    const changed = report.changedFiles.filter((f) => f.analysis !== 'ignored');
    const names = files.map((f) => path.basename(f)).join(', ');
    const total = report.durationsMs?.total;
    log.info(
      `${label}${names ? ` ${names}` : ''}: ${report.tests.length} test(s), ${changed.length} changed file(s)` +
        `${report.fallback ? `, fallback for ${report.fallback.testProjects.length} project(s)` : ''} ` +
        `(analysis ${formatDuration(total ?? elapsedMs)}${total !== undefined ? `, round trip ${formatDuration(elapsedMs)}` : ''}).`,
    );
    for (const symbol of report.changedSymbols.slice(0, 20)) {
      log.info(`  changed: ${symbol.symbol} (${symbol.kind}, ${symbol.reason})`);
    }
    if (report.changedSymbols.length > 20) {
      log.info(`  ... and ${report.changedSymbols.length - 20} more changed symbols`);
    }
    for (const reason of report.fallback?.reasons ?? []) {
      log.warn(`  fallback ${describeFallback(reason)} -> runs completely: ${reason.testProjects.map((p) => path.basename(p)).join(', ')}`);
    }
    for (const test of report.tests) {
      log.info(`  ${test.fullyQualifiedName} [${test.reason}]: ${test.chain.join(' <- ')}`);
    }
    for (const diagnostic of report.diagnostics ?? []) {
      (diagnostic.severity === 'error' ? log.warn : log.info).call(log, `  [analyzer ${diagnostic.source}] ${diagnostic.message}`);
    }
  }

  private logPlan(plans: readonly ProjectPlan[]): void {
    const log = this.deps.logger;
    log.info(`Run plan: ${plans.length} test project(s).`);
    for (const plan of plans) {
      const again = plan.tests.filter((t) => t.origin === 'previouslyFailed');
      if (plan.mode === 'all') {
        log.info(`  ${plan.name}: all tests (${plan.reasons.join('; ') || 'fallback'})`);
      } else {
        log.info(`  ${plan.name}: ${plan.tests.length} test(s)${again.length ? `, ${again.length} of them failed before` : ''}`);
      }
      for (const test of again) {
        log.info(`    re-run (failed before): ${test.fullyQualifiedName}`);
      }
    }
  }
}
