import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImpactReport, ImpactTest } from '../../src/core/analyzerProtocol';
import { CoverageManager, compactLines, type CoverageAnalyzer, type CoveragePolicy, type CoverageSettings } from '../../src/core/coverage';
import { CoverageStore } from '../../src/core/coverageStore';
import type { ProjectOutcome, RunOutcome } from '../../src/core/executor';
import { MemoryLogger } from '../../src/core/logger';
import type { RunnerMode } from '../../src/core/runnerMode';
import type { ProjectPlan } from '../../src/core/work';
import { tempDir, writeFile } from './helpers';

const cleanups: (() => void | Promise<void>)[] = [];
// Cleanups run in reverse: pending store writes are flushed before the temp dir is removed.
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=Unit', '-c', 'user.email=unit@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
}

const BASE_A = ['namespace App;', 'public static class A', '{', '    public static int One() => 1;', '}', ''].join('\n');
/** Lines 5-12 are new: a method with an if. */
const NEW_A = [
  'namespace App;',
  'public static class A',
  '{',
  '    public static int One() => 1;',
  '',
  '    public static int Two(bool flag)',
  '    {',
  '        if (flag)',
  '        {',
  '            return 2;',
  '        }',
  '        return 0;',
  '    }',
  '}',
  '',
].join('\n');

interface LineSpec {
  hits: number;
  covered?: number;
  total?: number;
}

/** A coverlet-style Cobertura report: one class and method per file, file names relative to the source. */
function cobertura(source: string, files: Record<string, Record<number, LineSpec>>): string {
  const classes = Object.entries(files).map(([file, lines]) => {
    const rows = Object.entries(lines)
      .map(([n, l]) => {
        const branch = l.total ? ` branch="True" condition-coverage="${Math.round((100 * (l.covered ?? 0)) / l.total)}% (${l.covered ?? 0}/${l.total})"` : ' branch="False"';
        return `<line number="${n}" hits="${l.hits}"${branch} />`;
      })
      .join('');
    const name = `App.${path.basename(file, '.cs')}`;
    return `<class name="${name}" filename="${file}"><methods><method name="Two" signature="(System.Boolean)"><lines>${rows}</lines></method></methods><lines>${rows}</lines></class>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?><coverage version="1.9"><sources><source>${source}</source></sources><packages><package name="App"><classes>${classes.join('')}</classes></package></packages></coverage>`;
}

/** Coverage of A.cs lines 6-12 (the new method) with one path or both. */
const ONE_PATH: Record<number, LineSpec> = { 4: { hits: 1 }, 7: { hits: 1 }, 8: { hits: 1, covered: 1, total: 2 }, 9: { hits: 1 }, 10: { hits: 1 }, 12: { hits: 0 }, 13: { hits: 1 } };
const OTHER_PATH: Record<number, LineSpec> = { 4: { hits: 0 }, 7: { hits: 1 }, 8: { hits: 1, covered: 1, total: 2 }, 9: { hits: 0 }, 10: { hits: 0 }, 12: { hits: 1 }, 13: { hits: 1 } };
const BOTH_PATHS: Record<number, LineSpec> = { 4: { hits: 1 }, 7: { hits: 2 }, 8: { hits: 2, covered: 2, total: 2 }, 9: { hits: 1 }, 10: { hits: 1 }, 12: { hits: 1 }, 13: { hits: 2 } };

class FakeAnalyzer implements CoverageAnalyzer {
  readonly calls: { base: string; files: readonly string[]; options?: { mergeBase?: boolean } }[] = [];
  /** Tests per file (basename) returned by impactSinceBase. */
  testsByFile = new Map<string, string[]>();

  constructor(readonly project: string) {}

  get testProjects() {
    return [{ name: 'App.Tests', path: this.project, frameworks: ['xunit'] }];
  }

  async impactSinceBase(base: string, files: readonly string[], options?: { mergeBase?: boolean }): Promise<ImpactReport> {
    this.calls.push({ base, files, options });
    const names = files.flatMap((f) => this.testsByFile.get(path.basename(f)) ?? []);
    const tests: ImpactTest[] = [...new Set(names)].map((name) => ({
      fullyQualifiedName: `App.Tests.ATests.${name}`,
      className: 'App.Tests.ATests',
      methodName: name,
      framework: 'xunit',
      project: this.project,
      projectName: 'App.Tests',
      reason: 'referenceChain',
      chain: ['A.Two', name],
    }));
    return {
      schemaVersion: 1,
      solution: '',
      repositoryRoot: '',
      durationsMs: { total: 1 },
      changedFiles: files.map((f) => ({ path: f, fullPath: f, status: 'modified', analysis: 'selective' })),
      changedSymbols: [],
      fallback: null,
      tests,
      testProjects: tests.length ? [{ name: 'App.Tests', path: this.project, mode: 'filter', tests: tests.length, frameworks: ['xunit'] }] : [],
      diagnostics: [],
    };
  }
}

function setup(options: { packages?: string[]; tool?: CoverageSettings['tool'] } = {}) {
  const { dir, cleanup } = tempDir('aftershock-cov-');
  cleanups.push(cleanup);
  const managers: CoverageManager[] = [];
  cleanups.push(async () => {
    await Promise.all(managers.map((m) => m.flushed()));
  });
  const repo = path.join(dir, 'repo');
  const a = path.join(repo, 'src', 'App', 'A.cs');
  const b = path.join(repo, 'src', 'App', 'B.cs');
  const testFile = path.join(repo, 'tests', 'App.Tests', 'ATests.cs');
  const project = path.join(repo, 'tests', 'App.Tests', 'App.Tests.csproj');
  writeFile(a, BASE_A);
  writeFile(b, 'namespace App;\npublic static class B\n{\n    public static int Three() => 3;\n}\n');
  writeFile(testFile, 'namespace App.Tests;\npublic class ATests { }\n');
  writeFile(project, '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFile(path.join(repo, '.gitignore'), 'obj/\nbin/\n');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const packages = options.packages ?? ['coverlet.collector', 'Microsoft.CodeCoverage'];
  writeFile(
    path.join(repo, 'tests', 'App.Tests', 'obj', 'project.assets.json'),
    JSON.stringify({ libraries: Object.fromEntries(packages.map((p) => [`${p}/1.0.0`, { type: 'package' }])) }),
  );

  const analyzer = new FakeAnalyzer(project);
  const logger = new MemoryLogger();
  const settings: CoverageSettings = { enabled: true, tool: options.tool ?? 'coverlet', targetBranch: '' };
  const policy: CoveragePolicy = { thresholdPercent: 85, thresholdSource: 'setting', exclusions: [] };
  const storeFile = path.join(dir, 'storage', 'coverage.json');
  let clock = 1000;
  const make = () => {
    const manager = new CoverageManager({
      solutionDirectory: repo,
      storeFile,
      analyzer,
      logger,
      settings: () => settings,
      policy: () => policy,
      now: () => ++clock,
    });
    managers.push(manager);
    return manager;
  };
  const coverage = make();
  let runCount = 0;

  /** One run of the given tests with these coverage reports (one per entry), through the run hooks. */
  async function run(reports: Record<string, Record<number, LineSpec>>[], opts: { mode?: 'filter' | 'all'; status?: ProjectOutcome['status']; runnerMode?: RunnerMode; manager?: CoverageManager; beforeEnd?: () => void } = {}) {
    const manager = opts.manager ?? coverage;
    const plan: ProjectPlan = { path: project, name: 'App.Tests', frameworks: ['xunit'], mode: opts.mode ?? 'filter', reasons: [], tests: [] };
    await manager.beforeRun([plan]);
    const resultsDirectory = path.join(dir, 'results', `run-${++runCount}`, 'App.Tests-1');
    fs.mkdirSync(resultsDirectory, { recursive: true });
    const args = manager.testArguments({ project: plan, runnerMode: opts.runnerMode ?? 'vstest', resultsDirectory, batch: 1 });
    if (args.length > 0) {
      reports.forEach((files, i) => writeFile(path.join(resultsDirectory, `guid-${i}`, 'coverage.cobertura.xml'), cobertura(`${repo}${path.sep}`, files)));
    }
    const status = opts.status ?? 'passed';
    const outcome: ProjectOutcome = {
      plan,
      status,
      results: status === 'buildFailed' ? [] : [{ className: 'App.Tests.ATests', methodName: 'X', fullyQualifiedName: 'App.Tests.ATests.X', outcome: 'passed', cases: 1, failedCases: 0, durationMs: 1 }],
      runnerMode: opts.runnerMode ?? 'vstest',
      durations: {},
    };
    if (status === 'passed' || status === 'failed') {
      manager.afterProject(outcome, { resultsDirectories: [resultsDirectory] });
    }
    opts.beforeEnd?.();
    const result: RunOutcome = { projects: [outcome], cancelled: false, durationMs: 1 };
    await manager.afterRun(result);
    return args;
  }

  return { repo, a, b, testFile, project, analyzer, logger, settings, policy, coverage, make, run, storeFile };
}

const A_REL = path.join('src', 'App', 'A.cs');

describe('CoverageManager', () => {
  it('before anything is measured: "unknown", with the new code known', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    await t.coverage.refreshNewCode();
    const summary = t.coverage.summary();
    expect(summary.state).toBe('unknown');
    expect(summary.target).toBe('origin/main');
    expect(summary.files.map((f) => [f.relativePath, f.state])).toEqual([['src/App/A.cs', 'unmeasured']]);
  });

  it('save -> all new code of the file -> run -> exact numbers; one path tested gives 75%, 1 more to 85%', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    const report = await t.coverage.impactForSaved([t.a]);
    expect(report?.tests.map((x) => x.methodName)).toEqual(['Two_True']);
    // The merge base is passed as the base, compared directly.
    expect(t.analyzer.calls[0].options).toEqual({ mergeBase: false });
    expect(t.analyzer.calls[0].base).toMatch(/^[0-9a-f]{40}$/);
    expect(t.coverage.summary().files[0].state).toBe('pending');

    const args = await t.run([{ [A_REL]: ONE_PATH }]);
    expect(args).toEqual(['--collect', 'XPlat Code Coverage;Format=cobertura']);
    const summary = t.coverage.summary();
    expect(summary.state).toBe('measured');
    // New lines 5-13; coverable among them: 7, 8, 9, 10, 12, 13. Line 4 is old code (not counted).
    expect(summary.counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    expect(summary.tenths).toBe(750);
    expect(summary.needed).toBe(1);
    expect(summary.notMeasured).toBe(0);
    const view = t.coverage.fileView(t.a)!;
    expect(view.complete).toBe(true);
    expect(view.metrics.uncoveredLines).toEqual([12]);
    expect(view.metrics.partialLines).toEqual([{ line: 8, hits: 1, covered: 1, total: 2 }]);
    expect(t.logger.lines.some((l) => l.includes('src/App/A.cs: 75% (lines 5/6; conditions 1/2; uncovered: 12; partly covered: 8 (1/2))'))).toBe(true);
    expect(t.logger.lines.some((l) => l.includes('1 more line(s) or condition(s) to cover to reach the target'))).toBe(true);
  });

  it('saving the file unchanged keeps its coverage (no new request); editing it invalidates it', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([{ [A_REL]: ONE_PATH }]);
    expect(await t.coverage.impactForSaved([t.a])).toBeUndefined();
    expect(t.analyzer.calls).toHaveLength(1);

    writeFile(t.a, NEW_A.replace('return 2;', 'return 3;'));
    await t.coverage.impactForSaved([t.a]);
    expect(t.analyzer.calls).toHaveLength(2);
    expect(t.coverage.store.get(t.a)).toBeUndefined();
    expect(t.coverage.summary().state).toBe('unknown');
    expect(t.coverage.fileView(t.a)).toBeUndefined();
  });

  it('a partial run for another file merges into the complete entry without re-running it', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    writeFile(t.b, 'namespace App;\npublic static class B\n{\n    public static int Three() => 3;\n    public static int Four() => 4;\n}\n');
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    t.analyzer.testsByFile.set('B.cs', ['Four']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([{ [A_REL]: ONE_PATH }]);
    // Saving B: only B is requested; the run happens to execute A's new line 12 as well.
    await t.coverage.impactForSaved([t.b]);
    expect(t.analyzer.calls.map((c) => c.files.map((f) => path.basename(f)))).toEqual([['A.cs'], ['B.cs']]);
    await t.run([{ [A_REL]: { 12: { hits: 1 }, 8: { hits: 1, covered: 0, total: 2 } }, [path.join('src', 'App', 'B.cs')]: { 4: { hits: 0 }, 5: { hits: 1 } } }]);
    const files = t.coverage.summary().files;
    expect(files.map((f) => [f.relativePath, f.state])).toEqual([
      ['src/App/A.cs', 'measured'],
      ['src/App/B.cs', 'measured'],
    ]);
    expect(files[0].metrics!.counts).toEqual({ coverableLines: 6, coveredLines: 6, conditions: 2, coveredConditions: 1 });
    // No test code changed: no follow-up.
    expect(t.coverage.takeFollowUp()).toBeUndefined();
  });

  it('a changed test that covers the other path: ambiguous merge -> one follow-up run of all of the file\'s tests -> 100%', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([{ [A_REL]: ONE_PATH }]);

    // The test file is saved (a new test); it is not new code itself.
    writeFile(t.testFile, 'namespace App.Tests;\npublic class ATests { /* Two_False */ }\n');
    expect(await t.coverage.impactForSaved([t.testFile])).toBeUndefined();
    expect(t.coverage.store.testCodeChanged).toBe(true);
    await t.run([{ [A_REL]: OTHER_PATH }]);
    // Conservative until the follow-up ran: line 8 stays at 1 of 2.
    expect(t.coverage.summary().counts).toEqual({ coverableLines: 6, coveredLines: 6, conditions: 2, coveredConditions: 1 });
    expect(t.coverage.store.testCodeChanged).toBe(false);

    const followUp = t.coverage.takeFollowUp();
    expect(followUp).toBeDefined();
    expect(t.coverage.takeFollowUp()).toBeUndefined();
    t.analyzer.testsByFile.set('A.cs', ['Two_True', 'Two_False']);
    const report = await followUp!();
    expect(report?.tests.map((x) => x.methodName)).toEqual(['Two_True', 'Two_False']);
    // Until the follow-up ran, the file keeps its (conservative) numbers.
    expect(t.coverage.store.awaiting.size).toBe(1);
    expect(t.coverage.summary().files[0].state).toBe('measured');
    await t.run([{ [A_REL]: BOTH_PATHS }]);
    const summary = t.coverage.summary();
    expect(summary.counts).toEqual({ coverableLines: 6, coveredLines: 6, conditions: 2, coveredConditions: 2 });
    expect(summary.tenths).toBe(1000);
    expect(summary.needed).toBe(0);
    expect(t.coverage.takeFollowUp()).toBeUndefined();
  });

  it('two test projects that each cover one condition are counted conservatively within a run', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([{ [A_REL]: ONE_PATH }, { [A_REL]: OTHER_PATH }]);
    expect(t.coverage.summary().counts).toEqual({ coverableLines: 6, coveredLines: 6, conditions: 2, coveredConditions: 1 });
    expect(t.logger.lines.some((l) => l.includes('counted conservatively'))).toBe(true);
  });

  it('a file that changes during the run keeps no coverage from it', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([{ [A_REL]: ONE_PATH }], { beforeEnd: () => writeFile(t.a, NEW_A.replace('return 0;', 'return -1;')) });
    expect(t.coverage.store.get(t.a)).toBeUndefined();
    expect(t.logger.lines.some((l) => l.includes('changed during the run'))).toBe(true);
  });

  it('a failed build leaves the file pending; the next run completes it', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([], { status: 'buildFailed' });
    expect(t.coverage.summary().files[0].state).toBe('pending');
    await t.run([{ [A_REL]: ONE_PATH }]);
    expect(t.coverage.summary().files[0].state).toBe('measured');
  });

  it('a project without the collector package: no arguments, a clear problem, nothing measured', async () => {
    const t = setup({ packages: ['Microsoft.CodeCoverage'] });
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    expect(await t.run([{ [A_REL]: ONE_PATH }])).toEqual([]);
    const summary = t.coverage.summary();
    expect(summary.state).toBe('unknown');
    expect(summary.collectionProblems).toHaveLength(1);
    expect(summary.collectionProblems[0]).toContain('coverlet.collector');
    expect(t.logger.lines.some((l) => l.startsWith('[warn] Coverage: App.Tests runs on VSTest and does not reference coverlet.collector'))).toBe(true);
  });

  it('coverlet under Microsoft.Testing.Platform needs coverlet.MTP; Microsoft Code Coverage its extension', async () => {
    const t = setup({ packages: ['coverlet.collector'] });
    writeFile(t.a, NEW_A);
    await t.coverage.refreshNewCode();
    expect(await t.run([], { runnerMode: 'mtp' })).toEqual([]);
    expect(t.coverage.summary().collectionProblems[0]).toContain('coverlet.MTP');
    const u = setup({ packages: ['coverlet.MTP', 'Microsoft.Testing.Extensions.CodeCoverage'] });
    await u.coverage.refreshNewCode();
    expect(await u.run([], { runnerMode: 'bridge' })).toEqual(['--coverlet', '--coverlet-output-format', 'cobertura']);
    u.settings.tool = 'microsoft';
    expect(await u.run([], { runnerMode: 'mtp' })).toEqual(['--coverage', '--coverage-output-format', 'cobertura']);
  });

  it('tests that ran but wrote no report are reported, not shown as 0%', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([]);
    expect(t.coverage.summary().collectionProblems[0]).toContain('no Cobertura report');
    expect(t.coverage.summary().state).toBe('unknown');
  });

  it('a run of every test project completes every file it reports, without a request', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    await t.coverage.refreshNewCode();
    await t.run([{ [A_REL]: ONE_PATH }], { mode: 'all' });
    expect(t.coverage.summary().files[0].state).toBe('measured');
  });

  it('a run of every test project without any report (collector missing) completes nothing', async () => {
    const t = setup({ packages: [] });
    writeFile(t.a, NEW_A);
    await t.coverage.refreshNewCode();
    await t.run([{ [A_REL]: ONE_PATH }], { mode: 'all' });
    expect(t.coverage.summary().state).toBe('unknown');
    expect(t.coverage.store.get(t.a)).toBeUndefined();
  });

  it('new code that no test reaches: "unreached", then 0% once a run instruments the project', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    const report = await t.coverage.impactForSaved([t.a]);
    expect(report?.tests).toEqual([]);
    expect(t.coverage.summary().files[0].state).toBe('unreached');
    await t.run([{ [A_REL]: { 4: { hits: 1 }, 7: { hits: 0 }, 8: { hits: 0, covered: 0, total: 2 }, 9: { hits: 0 }, 10: { hits: 0 }, 12: { hits: 0 }, 13: { hits: 0 } } }]);
    const summary = t.coverage.summary();
    expect(summary.files[0].state).toBe('measured');
    expect(summary.tenths).toBe(0);
    // ceil(0.85 * 8) = 7
    expect(summary.needed).toBe(7);
  });

  it('a partial run alone does not count as measured', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    await t.coverage.refreshNewCode();
    await t.run([{ [A_REL]: ONE_PATH }]);
    const summary = t.coverage.summary();
    expect(summary.state).toBe('unknown');
    expect(summary.files[0].state).toBe('partial');
    expect(t.coverage.fileView(t.a)?.complete).toBe(false);
  });

  it('persists across a reload; another tool\'s numbers do not count', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    await t.coverage.impactForSaved([t.a]);
    await t.run([{ [A_REL]: ONE_PATH }]);
    await t.coverage.flushed();
    expect(fs.existsSync(t.storeFile)).toBe(true);

    const reloaded = t.make();
    await reloaded.refreshNewCode();
    expect(reloaded.summary().counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    t.settings.tool = 'microsoft';
    expect(reloaded.summary().state).toBe('unknown');
    expect(reloaded.fileView(t.a)).toBeUndefined();
  });

  it('exclusions, test projects and a missing target branch', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    writeFile(t.testFile, 'namespace App.Tests;\npublic class ATests { int x; }\n');
    await t.coverage.refreshNewCode();
    expect(t.coverage.summary().files.map((f) => f.relativePath)).toEqual(['src/App/A.cs']);
    t.policy.exclusions = ['**/App/A.cs'];
    expect(t.coverage.summary().state).toBe('noNewCode');
    t.policy.exclusions = ['A.cs'];
    expect(t.coverage.summary().state).toBe('noNewCode');
    t.policy.exclusions = [];
    t.settings.targetBranch = 'origin/missing';
    await t.coverage.refreshNewCode();
    const summary = t.coverage.summary();
    expect(summary.state).toBe('error');
    expect(summary.error).toContain('origin/missing');
    t.settings.enabled = false;
    expect(t.coverage.summary().state).toBe('disabled');
    expect(await t.coverage.impactForSaved([t.a])).toBeUndefined();
  });

  it('Recompute asks for all new code at once', async () => {
    const t = setup();
    writeFile(t.a, NEW_A);
    writeFile(t.b, 'namespace App;\npublic static class B { public static int X() => 1; }\n');
    t.analyzer.testsByFile.set('A.cs', ['Two_True']);
    t.analyzer.testsByFile.set('B.cs', ['X']);
    const report = await t.coverage.recomputeAll();
    expect(t.analyzer.calls[0].files.map((f) => path.basename(f)).sort()).toEqual(['A.cs', 'B.cs']);
    expect(report?.tests).toHaveLength(2);
    expect(t.coverage.summary().files.map((f) => f.state)).toEqual(['pending', 'pending']);
  });
});

describe('coverage store', () => {
  it('round-trips through JSON with branch keys interned', () => {
    const store = new CoverageStore();
    store.set({
      path: '/r/A.cs',
      hash: 'h1',
      tool: 'microsoft',
      complete: true,
      updatedAt: 5,
      lines: new Map([
        [3, { hits: 2, branches: [{ key: 'A|M()', covered: 1, total: 2 }, { key: 'A|N()', covered: 2, total: 2 }] }],
        [4, { hits: 0 }],
      ]),
    });
    store.addAwaiting({ path: '/r/B.cs', hash: 'h2', projects: ['/r/T.csproj'], reason: 'saved', requestedAt: 7 });
    store.testCodeChanged = true;
    const json = JSON.parse(JSON.stringify(store.toJSON()));
    expect(json.files[0].k).toEqual(['A|M()', 'A|N()']);
    const copy = CoverageStore.fromJSON(json);
    expect(copy.get('/r/A.cs')).toEqual(store.get('/r/A.cs'));
    expect(copy.awaiting.get('/r/B.cs')).toEqual(store.awaiting.get('/r/B.cs'));
    expect(copy.testCodeChanged).toBe(true);
    expect(copy.valid('/r/A.cs', 'h1', 'microsoft')).toBeDefined();
    expect(copy.valid('/r/A.cs', 'h1', 'coverlet')).toBeUndefined();
    expect(copy.valid('/r/A.cs', 'other', 'microsoft')).toBeUndefined();
    expect(CoverageStore.fromJSON({ version: 99 }).files.size).toBe(0);
    expect(CoverageStore.fromJSON(undefined).files.size).toBe(0);
  });
});

describe('compactLines', () => {
  it('collapses runs', () => {
    expect(compactLines([1, 2, 3, 7, 9, 10])).toBe('1-3, 7, 9-10');
    expect(compactLines([])).toBe('');
  });
});
