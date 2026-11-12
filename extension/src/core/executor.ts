import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatDuration, type Logger } from './logger';
import { parseMtpConsole } from './mtpConsole';
import { formatCommand, pathKey } from './paths';
import { dotnetEnvironment, runProcess, type ProcessRunner, type RunResult } from './processRunner';
import { checkRestore, looksLikeMissingRestore, newestRestoreInput } from './restore';
import {
  decideRunnerMode,
  mtpFilterStyle,
  parseGetPropertyOutput,
  readGlobalJsonRunner,
  RUNNER_PROPERTIES,
  type ProjectProperties,
  type RunnerDecision,
  type RunnerMode,
} from './runnerMode';
import { DEFAULT_MAX_FILTER_LENGTH, planVsTestFilters, planXunitV3Args, quoteForBridge, translateUserFilterForXunitV3 } from './testFilter';
import { aggregateByMethod, methodNameFromTrx, parseTrx, type TestMethodResult, type TrxRow } from './trx';
import type { ProjectPlan, StateStore } from './work';

export interface ExecutorSettings {
  dotnetPath: string;
  /** `aftershock.testFilter` (VSTest syntax). */
  testFilter: string;
  disableAnalyzersInBuild: boolean;
  maxFilterLength?: number;
}

export interface TestRunContext {
  project: ProjectPlan;
  runnerMode: RunnerMode;
  resultsDirectory: string;
  batch: number;
  /** MSBuild properties read for the runner mode (ProjectAssetsFile, ...), when known. */
  properties?: ProjectProperties;
}

/**
 * Extension points of the run pipeline (M4 coverage: `--collect` arguments and Cobertura parsing after
 * each project; later: Test Explorer updates).
 */
export interface RunHooks {
  /** Before the first restore/build of a run. */
  beforeRun?(plans: readonly ProjectPlan[]): void | Promise<void>;
  /** Extra `dotnet test` arguments; in bridge and MTP modes they are passed to the test application. */
  testArguments?(context: TestRunContext): string[];
  afterProject?(outcome: ProjectOutcome, context: { resultsDirectories: string[] }): void | Promise<void>;
  afterRun?(outcome: RunOutcome): void | Promise<void>;
}

export type ProjectStatus = 'passed' | 'failed' | 'buildFailed' | 'restoreFailed' | 'testRunFailed' | 'cancelled' | 'notRun';

export interface ProjectOutcome {
  plan: ProjectPlan;
  status: ProjectStatus;
  results: TestMethodResult[];
  runnerMode?: RunnerMode;
  /** One-line problem description. */
  message?: string;
  /** Error lines (build errors, runner output). */
  details?: string[];
  durations: { restore?: number; build?: number; test?: number };
}

export interface RunOutcome {
  projects: ProjectOutcome[];
  cancelled: boolean;
  durationMs: number;
}

export type ExecutorProgress =
  | { phase: 'restoring'; project: string }
  | { phase: 'building'; project: string; index: number; count: number }
  | { phase: 'testing'; tests: number | undefined; projects: number };

const RESTORE_STAMPS_KEY = 'aftershock.restoreStamps';
const KEPT_RUN_DIRECTORIES = 5;

interface ModeCacheEntry {
  inputsMtime: number;
  properties?: ProjectProperties;
  decision: RunnerDecision;
}

export interface ExecutorDependencies {
  solutionDirectory: string;
  /** Root folder for TRX files (one subfolder per run). */
  resultsRoot: string;
  state: StateStore;
  logger: Logger;
  settings: () => ExecutorSettings;
  runProcess?: ProcessRunner;
  hooks?: RunHooks[];
  /** Test projects run in parallel up to this number (builds are always sequential). */
  testConcurrency?: number;
}

/** Restore -> build -> test -> TRX for a set of project plans. Free of the vscode module. */
export class PlanExecutor {
  private readonly modeCache = new Map<string, ModeCacheEntry>();
  private readonly run: ProcessRunner;

  constructor(private readonly deps: ExecutorDependencies) {
    this.run = deps.runProcess ?? runProcess;
  }

  /** Forget cached runner modes (for example after a settings change). */
  invalidate(): void {
    this.modeCache.clear();
  }

  async execute(plans: readonly ProjectPlan[], signal: AbortSignal, progress: (p: ExecutorProgress) => void = () => undefined): Promise<RunOutcome> {
    const started = Date.now();
    const outcomes: ProjectOutcome[] = plans.map((plan) => ({ plan, status: 'notRun', results: [], durations: {} }));
    const runDirectory = this.createRunDirectory();
    const settings = this.deps.settings();
    const log = this.deps.logger;
    for (const hook of this.deps.hooks ?? []) {
      try {
        await hook.beforeRun?.(plans);
      } catch (error) {
        log.warn(`beforeRun hook failed: ${(error as Error).message}`);
      }
    }

    // 1. Restore (when needed) and build, one project after the other: test projects share their
    //    dependencies, and parallel builds would race on the same obj/ folders.
    const built: ProjectOutcome[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      if (signal.aborted) {
        break;
      }
      const outcome = outcomes[i];
      if (!(await this.restoreIfNeeded(outcome, signal, progress))) {
        continue;
      }
      if (signal.aborted) {
        break;
      }
      outcome.runnerMode = (await this.runnerMode(outcome.plan, signal)).mode;
      progress({ phase: 'building', project: outcome.plan.name, index: i + 1, count: outcomes.length });
      if (await this.build(outcome, settings, signal, progress)) {
        built.push(outcome);
      }
    }

    // 2. Tests, in parallel across projects.
    if (!signal.aborted && built.length > 0) {
      const selected = built.every((o) => o.plan.mode === 'filter') ? built.reduce((sum, o) => sum + o.plan.tests.length, 0) : undefined;
      progress({ phase: 'testing', tests: selected, projects: built.length });
      const queue = [...built];
      const workers = Array.from({ length: Math.max(1, Math.min(this.deps.testConcurrency ?? Math.min(4, os.cpus().length), queue.length)) }, async () => {
        for (let next = queue.shift(); next && !signal.aborted; next = queue.shift()) {
          await this.test(next, settings, runDirectory, signal);
        }
      });
      await Promise.all(workers);
    }

    const cancelled = signal.aborted;
    for (const outcome of outcomes) {
      if (cancelled && (outcome.status === 'notRun' || outcome.status === 'cancelled')) {
        outcome.status = 'cancelled';
      }
    }
    const result: RunOutcome = { projects: outcomes, cancelled, durationMs: Date.now() - started };
    for (const hook of this.deps.hooks ?? []) {
      try {
        await hook.afterRun?.(result);
      } catch (error) {
        log.warn(`afterRun hook failed: ${(error as Error).message}`);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------

  private createRunDirectory(): string {
    const root = this.deps.resultsRoot;
    fs.mkdirSync(root, { recursive: true });
    try {
      const old = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
        .map((entry) => entry.name)
        .sort();
      for (const name of old.slice(0, Math.max(0, old.length - (KEPT_RUN_DIRECTORIES - 1)))) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    } catch (error) {
      this.deps.logger.debug(`could not clean old result folders: ${(error as Error).message}`);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
    const directory = path.join(root, `run-${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  private async dotnet(args: string[], signal: AbortSignal, label: string, onLine?: (line: string) => void): Promise<RunResult> {
    const settings = this.deps.settings();
    this.deps.logger.info(`> ${formatCommand(settings.dotnetPath, args)}`);
    const result = await this.run({
      command: settings.dotnetPath,
      args,
      cwd: this.deps.solutionDirectory,
      env: dotnetEnvironment(),
      signal,
      onLine: (line) => {
        this.deps.logger.debug(`  [${label}] ${line}`);
        onLine?.(line);
      },
    });
    if (result.spawnError) {
      this.deps.logger.error(`Could not start "${settings.dotnetPath}": ${result.spawnError.message}. Check aftershock.dotnetPath.`);
    }
    return result;
  }

  private restoreStamps(): Record<string, number> {
    return this.deps.state.get<Record<string, number>>(RESTORE_STAMPS_KEY) ?? {};
  }

  private async restoreIfNeeded(outcome: ProjectOutcome, signal: AbortSignal, progress: (p: ExecutorProgress) => void, force?: string): Promise<boolean> {
    const plan = outcome.plan;
    const key = pathKey(plan.path);
    const cached = this.modeCache.get(key);
    const check = force ? { needed: true, reason: force } : checkRestore(plan.path, this.restoreStamps()[key], cached?.properties?.ProjectAssetsFile || undefined);
    if (!check.needed) {
      return true;
    }
    progress({ phase: 'restoring', project: plan.name });
    this.deps.logger.info(`Restore ${plan.name}: ${check.reason}`);
    const startedAt = Date.now();
    const result = await this.dotnet(['restore', plan.path, '-nologo'], signal, `restore ${plan.name}`);
    outcome.durations.restore = (outcome.durations.restore ?? 0) + result.durationMs;
    if (result.cancelled) {
      outcome.status = 'cancelled';
      return false;
    }
    if (result.exitCode !== 0) {
      outcome.status = 'restoreFailed';
      outcome.message = result.spawnError ? result.spawnError.message : `dotnet restore exited with ${result.exitCode}`;
      outcome.details = errorLines(result.output);
      this.deps.logger.error(`Restore ${plan.name} failed (${formatDuration(result.durationMs)}).`);
      outcome.details.forEach((line) => this.deps.logger.error(`  ${line}`));
      return false;
    }
    const stamps = this.restoreStamps();
    stamps[key] = startedAt;
    await this.deps.state.update(RESTORE_STAMPS_KEY, stamps);
    this.modeCache.delete(key);
    this.deps.logger.info(`Restore ${plan.name}: ${formatDuration(result.durationMs)}`);
    return true;
  }

  private async runnerMode(plan: ProjectPlan, signal: AbortSignal): Promise<RunnerDecision> {
    const key = pathKey(plan.path);
    const inputsMtime = newestRestoreInput(plan.path);
    const cached = this.modeCache.get(key);
    if (cached && cached.inputsMtime === inputsMtime) {
      return cached.decision;
    }
    const globalRunner = readGlobalJsonRunner(this.deps.solutionDirectory);
    let properties: ProjectProperties | undefined;
    if (!globalRunner.runner) {
      const args = ['msbuild', plan.path, '-nologo', ...RUNNER_PROPERTIES.map((p) => `-getProperty:${p}`)];
      const result = await this.dotnet(args, signal, `properties ${plan.name}`);
      if (result.exitCode === 0) {
        try {
          properties = parseGetPropertyOutput(result.output);
        } catch (error) {
          this.deps.logger.warn(`Could not read the MSBuild properties of ${plan.name}: ${(error as Error).message}`);
        }
      } else if (!result.cancelled) {
        this.deps.logger.warn(`Could not read the MSBuild properties of ${plan.name} (exit ${result.exitCode}); assuming VSTest.`);
      }
    }
    const decision = decideRunnerMode(globalRunner, properties);
    this.deps.logger.info(`Runner mode of ${plan.name}: ${decision.mode} (${decision.reason})`);
    if (!signal.aborted) {
      this.modeCache.set(key, { inputsMtime, properties, decision });
    }
    return decision;
  }

  private async build(outcome: ProjectOutcome, settings: ExecutorSettings, signal: AbortSignal, progress: (p: ExecutorProgress) => void): Promise<boolean> {
    const plan = outcome.plan;
    const args = ['build', plan.path, '--no-restore', '-m', '-nologo'];
    if (settings.disableAnalyzersInBuild) {
      args.push('-p:RunAnalyzers=false');
    }
    args.push('-p:TreatWarningsAsErrors=false');

    let result = await this.dotnet(args, signal, `build ${plan.name}`);
    outcome.durations.build = result.durationMs;
    if (!result.cancelled && result.exitCode !== 0 && looksLikeMissingRestore(result.output)) {
      this.deps.logger.info(`Build ${plan.name} needs a restore; restoring and building again.`);
      if (!(await this.restoreIfNeeded(outcome, signal, progress, 'the build reported missing restore output'))) {
        return false;
      }
      result = await this.dotnet(args, signal, `build ${plan.name}`);
      outcome.durations.build += result.durationMs;
    }
    if (result.cancelled) {
      outcome.status = 'cancelled';
      return false;
    }
    if (result.exitCode !== 0) {
      outcome.status = 'buildFailed';
      outcome.message = result.spawnError ? result.spawnError.message : `dotnet build exited with ${result.exitCode}`;
      outcome.details = errorLines(result.output);
      this.deps.logger.error(`Build ${plan.name} failed (${formatDuration(result.durationMs)}):`);
      outcome.details.forEach((line) => this.deps.logger.error(`  ${line}`));
      return false;
    }
    this.deps.logger.info(`Build ${plan.name}: ${formatDuration(outcome.durations.build)}`);
    return true;
  }

  private async test(outcome: ProjectOutcome, settings: ExecutorSettings, runDirectory: string, signal: AbortSignal): Promise<void> {
    const plan = outcome.plan;
    const mode = outcome.runnerMode ?? 'vstest';
    const properties = this.modeCache.get(pathKey(plan.path))?.properties;
    const style = mode === 'vstest' ? 'vstest' : mtpFilterStyle(plan.frameworks, properties);
    const maxLength = settings.maxFilterLength ?? DEFAULT_MAX_FILTER_LENGTH;
    const log = this.deps.logger;

    // Selection arguments per batch (undefined = no selection: the whole project).
    let batches: (string[] | undefined)[] = [undefined];
    let common: string[] = [];
    if (style === 'xunit') {
      if (plan.mode === 'filter') {
        const xunit = planXunitV3Args(plan.tests, settings.testFilter, maxLength);
        xunit.warnings.forEach((warning) => log.warn(warning));
        common = xunit.common;
        batches = xunit.batches;
        if (xunit.level === 'class') {
          log.info(`${plan.name}: the method selection is longer than ${maxLength} characters; selecting whole classes${xunit.batches.length > 1 ? ` in ${xunit.batches.length} batches` : ''}.`);
        }
      } else {
        const translated = translateUserFilterForXunitV3(settings.testFilter);
        if (translated.warning) {
          log.warn(translated.warning);
        }
        common = translated.args;
      }
    } else if (plan.mode === 'filter') {
      const filters = planVsTestFilters(plan.tests, settings.testFilter, maxLength);
      batches = filters.batches.map((filter) => ['--filter', filter]);
      if (filters.level === 'class') {
        log.info(`${plan.name}: the filter is longer than ${maxLength} characters; selecting whole classes${filters.batches.length > 1 ? ` in ${filters.batches.length} batches` : ''}.`);
      }
    } else if (settings.testFilter.trim()) {
      batches = [['--filter', settings.testFilter.trim()]];
    }

    const rows: TrxRow[] = [];
    const resultsDirectories: string[] = [];
    const failures: string[] = [];
    let consoleFallbackUsed = false;
    const started = Date.now();
    for (let b = 0; b < batches.length && !signal.aborted; b++) {
      const resultsDirectory = path.join(runDirectory, `${safeName(plan.name)}-${b + 1}`);
      fs.mkdirSync(resultsDirectory, { recursive: true });
      resultsDirectories.push(resultsDirectory);
      const trxName = `${safeName(plan.name)}-${b + 1}.trx`;
      const context: TestRunContext = { project: plan, runnerMode: mode, resultsDirectory, batch: b + 1, properties };
      const extra = (this.deps.hooks ?? []).flatMap((hook) => hook.testArguments?.(context) ?? []);
      const selection = batches[b] ?? [];
      const reportArgs = style === 'xunit' ? ['--report-xunit-trx', '--report-xunit-trx-filename', trxName] : ['--report-trx', '--report-trx-filename', trxName];

      const buildArgs = (withReport: boolean): string[] => {
        if (mode === 'vstest') {
          return ['test', plan.path, '--no-build', '--nologo', '--logger', `trx;LogFileName=${trxName}`, '--results-directory', resultsDirectory, ...selection, ...extra];
        }
        const appArgs = [...selection, ...common, ...(withReport ? reportArgs : []), '--results-directory', resultsDirectory, ...extra];
        if (mode === 'bridge') {
          return ['test', plan.path, '--no-build', '--nologo', '--', ...appArgs.map(quoteForBridge)];
        }
        return ['test', '--project', plan.path, '--no-build', ...appArgs];
      };

      let result = await this.dotnet(buildArgs(true), signal, `test ${plan.name}`);
      if (result.cancelled) {
        break;
      }
      if (mode !== 'vstest' && /Unknown option '--report-(xunit-)?trx/i.test(result.output)) {
        log.warn(`${plan.name} has no TRX report extension (add the Microsoft.Testing.Extensions.TrxReport package); falling back to reading the console output.`);
        consoleFallbackUsed = true;
        result = await this.dotnet(buildArgs(false), signal, `test ${plan.name}`);
        if (result.cancelled) {
          break;
        }
      }

      const trxFiles = findTrxFiles(resultsDirectory);
      const before = rows.length;
      for (const file of trxFiles) {
        try {
          const trx = parseTrx(fs.readFileSync(file, 'utf8'));
          rows.push(...trx.rows);
          trx.runMessages.forEach((message) => log.debug(`  [${plan.name}] ${message}`));
        } catch (error) {
          log.warn(`Could not read ${file}: ${(error as Error).message}`);
        }
      }
      if (trxFiles.length === 0 && consoleFallbackUsed) {
        rows.push(...consoleRows(result, plan));
      }
      const zeroTests = mode !== 'vstest' && result.exitCode === 8;
      if (rows.length === before && result.exitCode !== 0 && !zeroTests) {
        failures.push(`dotnet test exited with ${result.exitCode ?? result.signal}${result.spawnError ? `: ${result.spawnError.message}` : ''}`);
        failures.push(...tail(result.output, 25));
      }
    }
    outcome.durations.test = Date.now() - started;

    if (signal.aborted) {
      outcome.status = 'cancelled';
      return;
    }
    outcome.results = aggregateByMethod(rows);
    const failed = outcome.results.filter((r) => r.outcome === 'failed').length;
    const passed = outcome.results.filter((r) => r.outcome === 'passed').length;
    if (failures.length > 0 && outcome.results.length === 0) {
      outcome.status = 'testRunFailed';
      outcome.message = failures[0];
      outcome.details = failures.slice(1);
      log.error(`Tests of ${plan.name} could not run: ${failures[0]}`);
      failures.slice(1).forEach((line) => log.error(`  ${line}`));
    } else {
      outcome.status = failed > 0 ? 'failed' : 'passed';
      if (failures.length > 0) {
        log.warn(`Part of the test run of ${plan.name} failed: ${failures[0]}`);
      }
    }
    log.info(`Tests ${plan.name}: ${passed} passed, ${failed} failed, ${outcome.results.length - passed - failed} skipped (${formatDuration(outcome.durations.test)})`);
    for (const hook of this.deps.hooks ?? []) {
      try {
        await hook.afterProject?.(outcome, { resultsDirectories });
      } catch (error) {
        log.warn(`afterProject hook failed: ${(error as Error).message}`);
      }
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function findTrxFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.trx')) {
        files.push(full);
      } else if (entry.isDirectory() && depth < 2) {
        visit(full, depth + 1);
      }
    }
  };
  visit(directory, 0);
  return files.sort();
}

/** MSBuild/compiler error lines, de-duplicated (MSBuild repeats them in its summary). */
export function errorLines(output: string, max = 30): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/(:|\s)error\s+[A-Z]*\d*\s*:|^error\s*:|: error :/i.test(line) || seen.has(line)) {
      continue;
    }
    seen.add(line);
    lines.push(line);
    if (lines.length >= max) {
      break;
    }
  }
  return lines.length > 0 ? lines : tail(output, 15);
}

function tail(output: string, count: number): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

/** Rows from console output (no TRX extension): failures by name; the other selected tests passed if the run completed. */
function consoleRows(result: RunResult, plan: ProjectPlan): TrxRow[] {
  const summary = parseMtpConsole(result.output);
  const rows: TrxRow[] = [];
  const matched = new Set<string>();
  for (const failure of summary.failures) {
    const name = methodNameFromTrx(failure.name);
    const test =
      plan.tests.find((t) => t.fullyQualifiedName === name) ??
      plan.tests.find((t) => name.endsWith(`.${t.methodName}`) || name === t.methodName);
    const className = test?.className ?? (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : '');
    const methodName = test?.methodName ?? name.slice(name.lastIndexOf('.') + 1);
    if (test) {
      matched.add(test.fullyQualifiedName);
    }
    rows.push({ className, rawName: methodName, methodName, displayName: failure.name, outcome: 'Failed', message: failure.message });
  }
  const completed = result.exitCode === 0 || result.exitCode === 2;
  if (completed && plan.mode === 'filter') {
    for (const test of plan.tests) {
      if (!matched.has(test.fullyQualifiedName)) {
        rows.push({ className: test.className, rawName: test.methodName, methodName: test.methodName, displayName: test.fullyQualifiedName, outcome: 'Passed' });
      }
    }
  }
  return rows;
}
