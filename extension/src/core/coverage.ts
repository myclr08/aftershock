import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ImpactReport, WorkspaceTestProject } from './analyzerProtocol';
import { cloneFileCoverage, findCoberturaFiles, mergeFileCoverage, parseCobertura, resolveCoberturaPath, type FileCoverage } from './cobertura';
import { collectionPlan, hasPackage, missingPackageAdvice, type CoverageTool } from './coverageCollection';
import { addCounts, coverageTenths, fileMetrics, formatCoverage, formatTenths, neededForThreshold, ZERO_COUNTS, type CoverageCounts, type FileMetrics } from './coverageMetrics';
import { CoverageStore, type AwaitingFile } from './coverageStore';
import type { ProjectOutcome, RunHooks, RunOutcome, TestRunContext } from './executor';
import { matchesAnyGlob } from './glob';
import { formatDuration, type Logger } from './logger';
import { computeNewCode, runGit, type GitRunner, type NewCodeFile, type NewCodeResult } from './newCode';
import { pathKey } from './paths';
import type { ProjectPlan } from './work';

/** What the coverage needs from the analyzer (AnalyzerHost in the extension, fakes in tests). */
export interface CoverageAnalyzer {
  impactSinceBase(base: string, files: readonly string[], options?: { mergeBase?: boolean }): Promise<ImpactReport>;
  readonly testProjects: WorkspaceTestProject[] | undefined;
}

export interface CoverageSettings {
  enabled: boolean;
  tool: CoverageTool;
  /** `aftershock.targetBranch` (empty: automatic). */
  targetBranch: string;
}

/**
 * Threshold and exclusions. Today they come from the settings; from M5a the server's quality gate
 * (`new_coverage`) replaces the threshold and its `sonar.coverage.exclusions` / `sonar.exclusions`
 * are added to the exclusions, so the provider returns where each value came from.
 */
export interface CoveragePolicy {
  thresholdPercent: number;
  thresholdSource: 'setting' | 'server';
  exclusions: string[];
}

export interface CoverageDependencies {
  solutionDirectory: string;
  /** JSON file of the per-file store. */
  storeFile: string;
  analyzer: CoverageAnalyzer;
  logger: Logger;
  settings: () => CoverageSettings;
  policy: () => CoveragePolicy;
  git?: GitRunner;
  now?: () => number;
}

/** What the orchestrator calls (DESIGN.md 7.4). */
export interface CoverageParticipant {
  /** After `impact` of saved files: the tests of every new member of those files (impactSinceBase), if coverage needs them. */
  impactForSaved(files: readonly string[]): Promise<ImpactReport | undefined>;
  /** After a run was applied: a follow-up selection that recomputes files completely, if one is needed. */
  takeFollowUp(): (() => Promise<ImpactReport | undefined>) | undefined;
}

export type FileState =
  /** Complete coverage of the current content. */
  | 'measured'
  /** Only partial runs measured the current content. */
  | 'partial'
  /** A complete recomputation is pending (waiting for its run). */
  | 'pending'
  /** No test reaches the file's new code; its coverable lines are known once a run instruments its project. */
  | 'unreached'
  /** Nothing is known about the current content. */
  | 'unmeasured';

export interface FileSummary {
  path: string;
  relativePath: string;
  state: FileState;
  metrics?: FileMetrics;
}

export interface CoverageSummary {
  state: 'disabled' | 'error' | 'noNewCode' | 'unknown' | 'measured';
  error?: string;
  target?: string;
  mergeBase?: string;
  thresholdPercent: number;
  thresholdSource: CoveragePolicy['thresholdSource'];
  tool: CoverageTool;
  /** Over the measured files. */
  counts: CoverageCounts;
  /** Tenths of a percent, rounded down; undefined = "n/a" (no coverable new lines). */
  tenths?: number;
  /** More lines or conditions to cover to reach the threshold. */
  needed: number;
  files: FileSummary[];
  /** New-code files without complete coverage of their current content. */
  notMeasured: number;
  /** Projects of the last run whose coverage could not be collected, with the reason. */
  collectionProblems: string[];
}

/** For the editor decorations: one file's new-line coverage, if known. */
export interface FileCoverageView {
  complete: boolean;
  metrics: FileMetrics;
}

interface RunState {
  enabled: boolean;
  startedAt: number;
  tool: CoverageTool;
  /** Every test project runs completely (Run All): the keys of those projects. */
  fullRun: string[] | undefined;
  testCodeChanged: boolean;
  awaiting: Map<string, AwaitingFile>;
  /** Content hashes of the relevant files when the run started. */
  hashes: Map<string, string>;
  /** Files of interest (new code and awaiting): key -> path. */
  relevant: Map<string, string>;
  reports: Map<string, FileCoverage>;
  ambiguous: Map<string, Set<number>>;
  /** Projects (pathKey) whose tests ran with coverage arguments. */
  collecting: Set<string>;
  /** Projects (pathKey) that produced at least one report. */
  reported: Set<string>;
  problems: Map<string, string>;
  /** Content hashes of the reports read (the TRX logger keeps a copy of every attachment). */
  seenReports: Set<string>;
  reportFiles: number;
  parseMs: number;
}

function sha1(content: Buffer): string {
  return createHash('sha1').update(content).digest('hex');
}

async function hashFile(file: string): Promise<string | undefined> {
  try {
    return sha1(await fs.promises.readFile(file));
  } catch {
    return undefined;
  }
}

function projectsOf(report: ImpactReport): string[] {
  const projects = new Map<string, string>();
  for (const project of report.testProjects ?? []) {
    projects.set(pathKey(project.path), project.path);
  }
  for (const project of report.fallback?.testProjects ?? []) {
    projects.set(pathKey(project), project);
  }
  for (const test of report.tests ?? []) {
    projects.set(pathKey(test.project), test.project);
  }
  return [...projects.values()];
}

/**
 * New-code coverage (DESIGN.md 7): which lines are new (git), how coverage is collected (run hooks),
 * the per-file store with partial-run merging, and the numbers for the UI. Free of the vscode module.
 */
export class CoverageManager implements RunHooks, CoverageParticipant {
  readonly store: CoverageStore;
  private newCode: NewCodeResult | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private readonly hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  private run: RunState | undefined;
  private readonly followUp = new Map<string, string>();
  private lastProblems: string[] = [];
  private lastError: string | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly listeners: (() => void)[] = [];
  private readonly git: GitRunner;
  private readonly now: () => number;

  constructor(private readonly deps: CoverageDependencies) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
    this.store = CoverageStore.load(deps.storeFile);
  }

  onDidChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  get snapshot(): NewCodeResult | undefined {
    return this.newCode;
  }

  // ---------------------------------------------------------------------------------------------
  // New code

  /** Recomputes the new lines (target branch, merge base, diff) and the content hashes. Coalesced. */
  refreshNewCode(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.computeNewCode();
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async computeNewCode(): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      return;
    }
    const result = await computeNewCode(this.deps.solutionDirectory, settings.targetBranch, this.git, this.now);
    const before = this.describeNewCode(this.newCode);
    this.newCode = result;
    const snapshot = result.snapshot;
    if (!snapshot) {
      if (result.error !== this.lastError) {
        this.deps.logger.warn(`New-code coverage: ${result.error}.`);
      }
      this.lastError = result.error;
    } else {
      this.lastError = undefined;
      const description = this.describeNewCode(result);
      if (description !== before) {
        this.deps.logger.info(
          `New code: ${snapshot.files.size} C# file(s) changed against ${snapshot.target} (merge base ${snapshot.mergeBase.slice(0, 12)}, ${formatDuration(snapshot.durationMs)}).`,
        );
      }
      await this.updateHashes(this.newCodeFiles().map((f) => f.path));
      // Requests for files that are no longer new code are moot.
      for (const [key, awaiting] of this.store.awaiting) {
        if (!snapshot.files.has(key)) {
          this.store.awaiting.delete(key);
          this.deps.logger.debug(`  ${awaiting.path} is no longer new code; its pending coverage request is dropped.`);
        }
      }
    }
    this.emit();
  }

  private describeNewCode(result: NewCodeResult | undefined): string {
    if (!result) {
      return '';
    }
    const s = result.snapshot;
    if (!s) {
      return result.error ?? '';
    }
    return `${s.target}|${s.mergeBase}|${[...s.files.keys()].sort().join(',')}`;
  }

  private async updateHashes(files: readonly string[]): Promise<void> {
    await Promise.all(
      files.map(async (file) => {
        const key = pathKey(file);
        try {
          const stat = await fs.promises.stat(file);
          const cached = this.hashes.get(key);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return;
          }
          const hash = await hashFile(file);
          if (hash) {
            this.hashes.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
          }
        } catch {
          this.hashes.delete(key);
        }
      }),
    );
  }

  /** Content hash of a file as last seen (refreshNewCode / runs). */
  currentHash(file: string): string | undefined {
    return this.hashes.get(pathKey(file))?.hash;
  }

  private testProjectDirectories(): string[] {
    return (this.deps.analyzer.testProjects ?? []).map((p) => pathKey(path.dirname(p.path)));
  }

  isInTestProject(file: string): boolean {
    const key = pathKey(file);
    return this.testProjectDirectories().some((dir) => key.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
  }

  /** Why a file does not count for coverage, or undefined when it does. */
  exclusionOf(file: NewCodeFile, patterns: readonly string[] = this.deps.policy().exclusions, testDirectories: readonly string[] = this.testProjectDirectories()): string | undefined {
    if (!file.path.toLowerCase().endsWith('.cs')) {
      return 'not C#';
    }
    if (/[\\/](bin|obj)[\\/]/i.test(file.path)) {
      return 'build output';
    }
    const key = pathKey(file.path);
    if (testDirectories.some((dir) => key.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep))) {
      return 'test project';
    }
    if (patterns.length > 0) {
      const solutionRelative = path.relative(this.deps.solutionDirectory, file.path);
      const pattern = matchesAnyGlob([file.relativePath, solutionRelative], patterns, { caseInsensitive: process.platform === 'win32' || process.platform === 'darwin' });
      if (pattern) {
        return `excluded by ${pattern}`;
      }
    }
    return undefined;
  }

  /** New-code files that count for coverage (C#, not in a test project, not excluded). */
  newCodeFiles(): NewCodeFile[] {
    const snapshot = this.newCode?.snapshot;
    if (!snapshot) {
      return [];
    }
    const patterns = this.deps.policy().exclusions;
    const testDirectories = this.testProjectDirectories();
    return [...snapshot.files.values()].filter((file) => this.exclusionOf(file, patterns, testDirectories) === undefined).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private newCodeFile(file: string): NewCodeFile | undefined {
    const entry = this.newCode?.snapshot?.files.get(pathKey(file));
    return entry && this.exclusionOf(entry) === undefined ? entry : undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // Selection (CoverageParticipant)

  async impactForSaved(files: readonly string[]): Promise<ImpactReport | undefined> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      return undefined;
    }
    const csharp = files.filter((f) => f.toLowerCase().endsWith('.cs'));
    if (csharp.some((f) => this.isInTestProject(f)) && !this.store.testCodeChanged) {
      this.store.testCodeChanged = true;
      this.persist();
    }
    if (csharp.length === 0) {
      return undefined;
    }
    await this.refreshNewCode();
    const snapshot = this.newCode?.snapshot;
    if (!snapshot) {
      return undefined;
    }
    const wanted: { file: string; hash: string }[] = [];
    for (const saved of csharp) {
      const file = this.newCodeFile(saved);
      if (!file) {
        continue;
      }
      const hash = await hashFile(file.path);
      if (!hash) {
        continue;
      }
      const entry = this.store.get(file.path);
      if (entry && entry.hash === hash && entry.tool === settings.tool && entry.complete) {
        // Saved without a change: its coverage still holds.
        continue;
      }
      if (entry && entry.hash !== hash) {
        this.store.delete(file.path);
      }
      wanted.push({ file: file.path, hash });
    }
    if (wanted.length === 0) {
      return undefined;
    }
    return this.requestComplete(wanted, 'saved', snapshot.mergeBase);
  }

  takeFollowUp(): (() => Promise<ImpactReport | undefined>) | undefined {
    if (this.followUp.size === 0 || !this.deps.settings().enabled) {
      this.followUp.clear();
      return undefined;
    }
    const files = [...this.followUp.values()];
    this.followUp.clear();
    return async () => {
      await this.refreshNewCode();
      const snapshot = this.newCode?.snapshot;
      if (!snapshot) {
        return undefined;
      }
      const wanted: { file: string; hash: string }[] = [];
      for (const file of files) {
        const hash = await hashFile(file);
        if (hash && this.newCodeFile(file)) {
          wanted.push({ file, hash });
        }
      }
      if (wanted.length === 0) {
        return undefined;
      }
      this.deps.logger.info(`Coverage: a changed test reached new code of ${wanted.map((w) => path.basename(w.file)).join(', ')}; recomputing ${wanted.length === 1 ? 'it' : 'them'} completely.`);
      return this.requestComplete(wanted, 'followUp', snapshot.mergeBase);
    };
  }

  /** `Aftershock: Recompute New-Code Coverage`: the tests of all new code. */
  async recomputeAll(): Promise<ImpactReport | undefined> {
    if (!this.deps.settings().enabled) {
      this.deps.logger.info('Coverage is turned off (aftershock.coverageEnabled).');
      return undefined;
    }
    await this.refreshNewCode();
    const snapshot = this.newCode?.snapshot;
    if (!snapshot) {
      throw new Error(this.newCode?.error ?? 'the new code is not known');
    }
    const files = this.newCodeFiles();
    if (files.length === 0) {
      this.deps.logger.info(`Recompute new-code coverage: no C# file outside test projects changed against ${snapshot.target}.`);
      return undefined;
    }
    const wanted: { file: string; hash: string }[] = [];
    for (const file of files) {
      const hash = await hashFile(file.path);
      if (hash) {
        wanted.push({ file: file.path, hash });
      }
    }
    this.deps.logger.info(`Recompute new-code coverage: ${wanted.length} file(s) with new code against ${snapshot.target}.`);
    return this.requestComplete(wanted, 'recompute', snapshot.mergeBase);
  }

  private async requestComplete(wanted: { file: string; hash: string }[], reason: AwaitingFile['reason'], base: string): Promise<ImpactReport> {
    const started = this.now();
    const report = await this.deps.analyzer.impactSinceBase(
      base,
      wanted.map((w) => w.file),
      { mergeBase: false },
    );
    const projects = projectsOf(report);
    for (const { file, hash } of wanted) {
      this.store.addAwaiting({ path: file, hash, projects, reason, requestedAt: this.now() });
    }
    const names = wanted.length <= 3 ? wanted.map((w) => path.basename(w.file)).join(', ') : `${wanted.length} files`;
    this.deps.logger.debug(
      `Coverage: all new code of ${names}: ${report.tests.length} test(s)${report.fallback ? `, ${report.fallback.testProjects.length} project(s) completely` : ''} (${formatDuration(this.now() - started)}).`,
    );
    this.persist();
    this.emit();
    return report;
  }

  // ---------------------------------------------------------------------------------------------
  // Run hooks

  async beforeRun(plans: readonly ProjectPlan[]): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      this.run = undefined;
      return;
    }
    await this.refreshNewCode();
    const relevant = new Map<string, string>();
    for (const file of this.newCodeFiles()) {
      relevant.set(pathKey(file.path), file.path);
    }
    for (const [key, awaiting] of this.store.awaiting) {
      relevant.set(key, awaiting.path);
    }
    const hashes = new Map<string, string>();
    await Promise.all(
      [...relevant].map(async ([key, file]) => {
        const hash = await hashFile(file);
        if (hash) {
          hashes.set(key, hash);
        }
      }),
    );
    const testProjects = this.deps.analyzer.testProjects ?? [];
    const fullRun =
      testProjects.length > 0 && testProjects.every((project) => plans.some((plan) => pathKey(plan.path) === pathKey(project.path) && plan.mode === 'all'))
        ? testProjects.map((project) => pathKey(project.path))
        : undefined;
    this.run = {
      enabled: true,
      startedAt: this.now(),
      tool: settings.tool,
      fullRun,
      testCodeChanged: this.store.testCodeChanged,
      awaiting: new Map([...this.store.awaiting].map(([key, value]) => [key, { ...value }])),
      hashes,
      relevant,
      reports: new Map(),
      ambiguous: new Map(),
      collecting: new Set(),
      reported: new Set(),
      problems: new Map(),
      seenReports: new Set(),
      reportFiles: 0,
      parseMs: 0,
    };
  }

  testArguments(context: TestRunContext): string[] {
    const run = this.run;
    if (!run?.enabled) {
      return [];
    }
    const plan = collectionPlan(run.tool, context.runnerMode);
    const key = pathKey(context.project.path);
    if (hasPackage(context.project.path, plan.requiredPackage, context.properties?.ProjectAssetsFile) === false) {
      if (!run.problems.has(key)) {
        run.problems.set(key, missingPackageAdvice(run.tool, context.runnerMode, context.project.name));
      }
      return [];
    }
    run.collecting.add(key);
    return plan.args;
  }

  afterProject(outcome: ProjectOutcome, context: { resultsDirectories: string[] }): void {
    const run = this.run;
    if (!run?.enabled) {
      return;
    }
    const key = pathKey(outcome.plan.path);
    const started = this.now();
    const reports = context.resultsDirectories.flatMap((dir) => findCoberturaFiles(dir));
    const snapshot = this.newCode?.snapshot;
    const fallbackRoots = [snapshot?.repositoryRoot, this.deps.solutionDirectory].filter((r): r is string => !!r);
    for (const file of reports) {
      try {
        const content = fs.readFileSync(file);
        run.reported.add(key);
        const digest = sha1(content);
        if (run.seenReports.has(digest)) {
          continue;
        }
        run.seenReports.add(digest);
        const report = parseCobertura(content.toString('utf8'));
        run.reportFiles++;
        for (const [filename, coverage] of report.files) {
          const resolved = resolveCoberturaPath(filename, report.sources, { fallbackRoots });
          const fileKey = pathKey(resolved);
          if (!run.relevant.has(fileKey)) {
            continue;
          }
          const existing = run.reports.get(fileKey);
          if (!existing) {
            run.reports.set(fileKey, cloneFileCoverage(coverage));
          } else {
            const ambiguous = mergeFileCoverage(existing, coverage);
            if (ambiguous.length > 0) {
              const set = run.ambiguous.get(fileKey) ?? new Set<number>();
              ambiguous.forEach((line) => set.add(line));
              run.ambiguous.set(fileKey, set);
            }
          }
        }
      } catch (error) {
        this.deps.logger.warn(`Could not read the coverage report ${file}: ${(error as Error).message}`);
      }
    }
    run.parseMs += this.now() - started;
    const ran = outcome.results.length > 0;
    if (ran && reports.length === 0 && run.collecting.has(key) && !run.problems.has(key)) {
      run.problems.set(
        key,
        `${outcome.plan.name} (${outcome.runnerMode ?? 'vstest'}, ${run.tool}) ran its tests but wrote no Cobertura report; the output channel at debug level shows the test run's messages.`,
      );
    }
  }

  async afterRun(outcome: RunOutcome): Promise<void> {
    const run = this.run;
    this.run = undefined;
    if (!run?.enabled || outcome.cancelled) {
      return;
    }
    const log = this.deps.logger;
    const ran = new Set(outcome.projects.filter((p) => p.status === 'passed' || p.status === 'failed').map((p) => pathKey(p.plan.path)));
    const tool = run.tool;
    const now = this.now();
    const keys = new Set([...run.awaiting.keys(), ...run.reports.keys()]);
    // A run of every test project is complete for every file, if every project wrote a report.
    const fullRun = !!run.fullRun && run.fullRun.every((key) => run.reported.has(key));
    let completed = 0;
    let merged = 0;
    for (const key of keys) {
      const file = run.relevant.get(key);
      if (!file) {
        continue;
      }
      const started = run.hashes.get(key);
      const ended = await hashFile(file);
      if (!started || started !== ended) {
        log.debug(`  coverage of ${file} ignored: the file changed during the run`);
        continue;
      }
      const data = run.reports.get(key);
      const awaiting = run.awaiting.get(key);
      // Complete when every project of the file's selection ran and wrote a coverage report.
      const selectionRan = !!awaiting && awaiting.hash === started && awaiting.projects.every((p) => ran.has(pathKey(p)) && run.reported.has(pathKey(p)));
      const complete = fullRun || selectionRan;

      if (complete) {
        if (!data && awaiting && awaiting.projects.length === 0) {
          // No test reaches the new code, and no project of this run instruments the file.
          continue;
        }
        if (!data && !awaiting) {
          continue;
        }
        this.store.set({ path: file, hash: started, tool, complete: true, lines: data ?? new Map(), updatedAt: now });
        // Requests made after the run started (Recompute during a run) still wait for their own run.
        const current = this.store.awaiting.get(key);
        if (current && current.hash === started && current.requestedAt <= run.startedAt) {
          this.store.awaiting.delete(key);
        }
        completed++;
        const ambiguous = run.ambiguous.get(key);
        if (ambiguous && ambiguous.size > 0) {
          log.debug(`  ${path.basename(file)}: lines ${[...ambiguous].sort((a, b) => a - b).join(', ')} have conditions covered partly by more than one report (test project or batch); counted conservatively`);
        }
        continue;
      }
      if (!data) {
        continue;
      }
      const existing = this.store.valid(file, started, tool);
      if (!existing) {
        this.store.set({ path: file, hash: started, tool, complete: false, lines: data, updatedAt: now });
        merged++;
        continue;
      }
      const newLines = this.newCodeFile(file)?.lines;
      const before = newLines ? fileMetrics(newLines, existing.lines).counts : undefined;
      const ambiguousLines = mergeFileCoverage(existing.lines, data);
      existing.updatedAt = now;
      merged++;
      if (existing.complete && run.testCodeChanged && newLines) {
        const after = fileMetrics(newLines, existing.lines).counts;
        const ambiguousNew = ambiguousLines.some((line) => newLines === 'all' || newLines.includes(line));
        const changed = !!before && (before.coveredLines !== after.coveredLines || before.coveredConditions !== after.coveredConditions);
        if (ambiguousNew || changed) {
          // A changed test reached this file's new code: one run with all of its tests gives the exact
          // numbers (Cobertura cannot tell which conditions two runs covered).
          this.followUp.set(key, file);
        }
      }
    }
    this.store.testCodeChanged = false;
    for (const project of outcome.projects) {
      const key = pathKey(project.plan.path);
      if ((project.status === 'passed' || project.status === 'failed') && run.collecting.has(key) && !run.reported.has(key) && !run.problems.has(key) && project.results.length > 0) {
        run.problems.set(key, `${project.plan.name}: no Cobertura report was found in its results folder.`);
      }
    }
    this.lastProblems = [...run.problems.values()];
    for (const problem of this.lastProblems) {
      log.warn(`Coverage: ${problem}`);
    }
    log.info(
      `Coverage: ${run.reportFiles} report(s) read in ${formatDuration(run.parseMs)}; ${completed} file(s) measured completely, ${merged} merged from this partial run${fullRun ? ' (every test project ran completely)' : ''}.`,
    );
    this.persist();
    this.logSummary();
    this.emit();
  }

  // ---------------------------------------------------------------------------------------------
  // Results

  summary(): CoverageSummary {
    const settings = this.deps.settings();
    const policy = this.deps.policy();
    const base = {
      thresholdPercent: policy.thresholdPercent,
      thresholdSource: policy.thresholdSource,
      tool: settings.tool,
      counts: { ...ZERO_COUNTS },
      needed: 0,
      files: [] as FileSummary[],
      notMeasured: 0,
      collectionProblems: this.lastProblems,
    };
    if (!settings.enabled) {
      return { ...base, state: 'disabled' };
    }
    if (!this.newCode) {
      return { ...base, state: 'unknown' };
    }
    const snapshot = this.newCode.snapshot;
    if (!snapshot) {
      return { ...base, state: 'error', error: this.newCode.error };
    }
    const files: FileSummary[] = [];
    let counts: CoverageCounts = { ...ZERO_COUNTS };
    let measured = 0;
    for (const file of this.newCodeFiles()) {
      const hash = this.currentHash(file.path);
      const entry = this.store.valid(file.path, hash, settings.tool);
      const awaiting = this.store.awaiting.get(pathKey(file.path));
      if (entry?.complete) {
        const metrics = fileMetrics(file.lines, entry.lines);
        counts = addCounts(counts, metrics.counts);
        measured++;
        files.push({ path: file.path, relativePath: file.relativePath, state: 'measured', metrics });
        continue;
      }
      const state: FileState = awaiting && awaiting.hash === hash ? (awaiting.projects.length === 0 ? 'unreached' : 'pending') : entry ? 'partial' : 'unmeasured';
      files.push({ path: file.path, relativePath: file.relativePath, state, metrics: entry ? fileMetrics(file.lines, entry.lines) : undefined });
    }
    const common = { ...base, target: snapshot.target, mergeBase: snapshot.mergeBase, files, notMeasured: files.length - measured };
    if (files.length === 0) {
      return { ...common, state: 'noNewCode' };
    }
    if (measured === 0) {
      return { ...common, state: 'unknown' };
    }
    return { ...common, state: 'measured', counts, tenths: coverageTenths(counts), needed: neededForThreshold(counts, policy.thresholdPercent) };
  }

  /** New-line coverage of one file for the editor, when its current content was measured. */
  fileView(file: string): FileCoverageView | undefined {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      return undefined;
    }
    const newCode = this.newCodeFile(file);
    if (!newCode) {
      return undefined;
    }
    const entry = this.store.valid(file, this.currentHash(file), settings.tool);
    if (!entry) {
      return undefined;
    }
    return { complete: entry.complete, metrics: fileMetrics(newCode.lines, entry.lines) };
  }

  /** The summary in the output channel. */
  logSummary(): void {
    const log = this.deps.logger;
    const summary = this.summary();
    const threshold = `${summary.thresholdPercent}%${summary.thresholdSource === 'server' ? ' from the quality gate' : ''}`;
    switch (summary.state) {
      case 'disabled':
        return;
      case 'error':
        log.info(`New-code coverage: unknown (${summary.error}).`);
        return;
      case 'noNewCode':
        log.info(`New-code coverage: n/a (no C# change outside test projects against ${summary.target}).`);
        return;
      default:
        break;
    }
    if (summary.state === 'measured') {
      const c = summary.counts;
      log.info(
        `New-code coverage against ${summary.target}: ${formatCoverage(c)} (target ${threshold}; lines ${c.coveredLines}/${c.coverableLines}, conditions ${c.coveredConditions}/${c.conditions})` +
          (summary.tenths === undefined ? '.' : summary.needed > 0 ? `; ${summary.needed} more line(s) or condition(s) to cover to reach the target.` : '; target reached.') +
          (summary.notMeasured > 0 ? ` ${summary.notMeasured} file(s) not measured yet.` : ''),
      );
    } else {
      log.info(`New-code coverage against ${summary.target}: not measured yet (${summary.files.length} file(s) with new code). Run "Aftershock: Recompute New-Code Coverage".`);
    }
    for (const file of summary.files) {
      log.info(`  ${file.relativePath}: ${describeFile(file)}`);
    }
  }

  // ---------------------------------------------------------------------------------------------

  private persist(): void {
    this.saving = this.saving
      .then(() => this.store.save(this.deps.storeFile))
      .catch((error: Error) => this.deps.logger.warn(`Could not save the coverage store: ${error.message}`));
  }

  /** Resolves when pending writes of the store are done (tests). */
  flushed(): Promise<void> {
    return this.saving;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI listeners must not break the pipeline.
      }
    }
  }
}

function describeFile(file: FileSummary): string {
  const m = file.metrics;
  const detail = (metrics: FileMetrics) => {
    const c = metrics.counts;
    const parts = [`lines ${c.coveredLines}/${c.coverableLines}`, `conditions ${c.coveredConditions}/${c.conditions}`];
    if (metrics.uncoveredLines.length > 0) {
      parts.push(`uncovered: ${compactLines(metrics.uncoveredLines)}`);
    }
    if (metrics.partialLines.length > 0) {
      parts.push(`partly covered: ${metrics.partialLines.map((p) => `${p.line} (${p.covered}/${p.total})`).join(', ')}`);
    }
    return `${formatCoverage(c)} (${parts.join('; ')})`;
  };
  switch (file.state) {
    case 'measured':
      return detail(m!);
    case 'partial':
      return `not measured completely yet (from partial runs: ${detail(m!)})`;
    case 'pending':
      return 'waiting for its run';
    case 'unreached':
      return 'no test reaches its new code (0% once a run instruments its project)';
    default:
      return 'not measured yet';
  }
}

/** [1,2,3,7,9,10] -> "1-3, 7, 9-10" */
export function compactLines(lines: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) {
      j++;
    }
    parts.push(j > i ? `${lines[i]}-${lines[j]}` : String(lines[i]));
    i = j;
  }
  return parts.join(', ');
}

export { formatTenths };
