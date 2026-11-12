// End-to-end check of new-code coverage (DESIGN.md 7) without the VS Code UI: the real analyzer, real
// dotnet build/test with coverlet and Microsoft Code Coverage, real git, against a temporary git copy of
// samples/ImpactSample on a feature branch with a fake origin/main.
//
//   npm run bundle-analyzer && npm run test:e2e
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAnalyzerDll } from '../../src/core/analyzerLocation';
import { AnalyzerHost } from '../../src/core/analyzerHost';
import { CoverageManager, type CoveragePolicy, type CoverageSettings, type FileSummary } from '../../src/core/coverage';
import { PlanExecutor, type RunOutcome } from '../../src/core/executor';
import { formatDuration, MemoryLogger } from '../../src/core/logger';
import { Orchestrator } from '../../src/core/orchestrator';
import { dotnetEnvironment, runProcess } from '../../src/core/processRunner';
import { MemoryStateStore, type ProjectPlan } from '../../src/core/work';

const extensionRoot = path.resolve(__dirname, '..', '..');
const sampleSource = path.resolve(extensionRoot, '..', 'samples', 'ImpactSample');
const DEBOUNCE_MS = 300;
const verbose = process.env.AFTERSHOCK_E2E_VERBOSE === '1';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aftershock-cov-e2e-')));
const repo = path.join(root, 'repo');
const solutionDir = path.join(repo, 'samples', 'ImpactSample');
const solution = path.join(solutionDir, 'ImpactSample.sln');
const file = (relative: string) => path.join(solutionDir, ...relative.split('/'));
const DISCOUNT = 'src/Sample.Core/Discounts/DiscountCalculator.cs';
const LOYALTY_TESTS = 'tests/Sample.Tests.XUnit/LoyaltyDiscountTests.cs';
const MEMBER_TEST = 'Sample.Tests.XUnit.LoyaltyDiscountTests.Member_GetsOneOff';
const NON_MEMBER_TEST = 'Sample.Tests.XUnit.LoyaltyDiscountTests.NonMember_PaysFull';

const logger = new MemoryLogger((line) => {
  if (verbose) {
    console.log(line);
  }
});
const timings: string[] = [];
const outcomes: RunOutcome[] = [];
const plansSeen: ProjectPlan[][] = [];
const settings: CoverageSettings = { enabled: true, tool: 'coverlet', targetBranch: '' };
const policy: CoveragePolicy = { thresholdPercent: 85, thresholdSource: 'setting', exclusions: [] };
let analyzer: AnalyzerHost;
let orchestrator: Orchestrator;
let coverage: CoverageManager;

function git(...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=Aftershock E2E', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function read(relative: string): string {
  return fs.readFileSync(file(relative), 'utf8');
}

function edit(relative: string, from: string, to: string): string {
  const text = read(relative);
  if (!text.includes(from)) {
    throw new Error(`${relative} does not contain ${from}`);
  }
  fs.writeFileSync(file(relative), text.replace(from, to));
  return file(relative);
}

/** Inserts lines before the closing brace at the end of a file, in the file's own line endings. */
function insertBeforeLastBrace(relative: string, lines: string[]): string {
  const text = read(relative);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const brace = text.lastIndexOf('}');
  fs.writeFileSync(file(relative), `${text.slice(0, brace)}${lines.join(eol)}${eol}${text.slice(brace)}`);
  return file(relative);
}

/** 1-based line of the first line containing `needle`. */
function lineOf(relative: string, needle: string): number {
  const index = read(relative).split(/\r?\n/).findIndex((line) => line.includes(needle));
  if (index < 0) {
    throw new Error(`${relative} has no line with ${needle}`);
  }
  return index + 1;
}

/** Saves the files and waits until every run it causes (follow-ups included) is done. */
async function saveAndWait(files: string[]): Promise<{ runs: number; plans: ProjectPlan[][] }> {
  const before = outcomes.length;
  const plansBefore = plansSeen.length;
  orchestrator.onSaved(files);
  await settle(before);
  return { runs: outcomes.length - before, plans: plansSeen.slice(plansBefore) };
}

async function settle(before: number): Promise<void> {
  const end = Date.now() + 300000;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!orchestrator.isBusy && (outcomes.length > before || orchestrator.status.summary?.noTests)) {
      break;
    }
  }
  await orchestrator.whenIdle();
}

function discountFile(): FileSummary {
  const summary = coverage.summary();
  const found = summary.files.find((f) => f.relativePath === `samples/ImpactSample/${DISCOUNT}`);
  if (!found) {
    throw new Error(`no coverage entry for ${DISCOUNT}: ${summary.files.map((f) => f.relativePath).join(', ')} (${summary.state} ${summary.error ?? ''})`);
  }
  return found;
}

const testsOf = (plans: ProjectPlan[][]) => plans.map((plan) => plan.flatMap((p) => p.tests.map((t) => t.fullyQualifiedName)));

function testPhase(outcome: RunOutcome): number {
  return outcome.projects.reduce((sum, p) => sum + (p.durations.test ?? 0), 0);
}

beforeAll(async () => {
  const location = resolveAnalyzerDll(extensionRoot);
  if (!location.dll) {
    throw new Error(`Analyzer not built; run "npm run bundle-analyzer" first (looked in ${location.tried.join(', ')})`);
  }
  fs.cpSync(sampleSource, solutionDir, { recursive: true, filter: (src) => !/[\\/](bin|obj|TestResults)$/.test(src) });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'bin/\nobj/\nTestResults/\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  // A fake remote target branch; the work happens on a feature branch.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'feature');

  const restore = await runProcess({ command: 'dotnet', args: ['restore', solution, '-nologo'], cwd: solutionDir, env: dotnetEnvironment() });
  expect(restore.exitCode, restore.output).toBe(0);

  analyzer = new AnalyzerHost({ dotnetPath: 'dotnet', analyzerDll: location.dll, solution, options: { maxSymbols: 500, fallbackGlobs: ['**/appsettings*.json'] } }, logger);
  analyzer.start();
  await analyzer.whenReady();

  const state = new MemoryStateStore();
  coverage = new CoverageManager({
    solutionDirectory: solutionDir,
    storeFile: path.join(root, 'storage', 'coverage.json'),
    analyzer,
    logger,
    settings: () => settings,
    policy: () => policy,
  });
  const executor = new PlanExecutor({
    solutionDirectory: solutionDir,
    resultsRoot: path.join(root, 'results'),
    state,
    logger,
    settings: () => ({ dotnetPath: 'dotnet', testFilter: '', disableAnalyzersInBuild: true }),
    hooks: [coverage],
  });
  const recording = {
    execute: (plans: readonly ProjectPlan[], signal: AbortSignal, progress: Parameters<PlanExecutor['execute']>[2]) => {
      plansSeen.push(plans.map((p) => ({ ...p, tests: [...p.tests] })));
      return executor.execute(plans, signal, progress);
    },
  };
  orchestrator = new Orchestrator({ analyzer, executor: recording, state, logger, debounceMs: () => DEBOUNCE_MS, coverage });
  orchestrator.onRunCompleted((outcome) => outcomes.push(outcome));
  await coverage.refreshNewCode();
}, 600000);

afterAll(async () => {
  orchestrator?.dispose();
  await analyzer?.stop();
  await coverage?.flushed();
  const report = ['', 'Aftershock coverage e2e:', ...timings.map((t) => `  ${t}`), ''].join('\n');
  process.stdout.write(report);
  if (process.env.AFTERSHOCK_E2E_REPORT) {
    fs.appendFileSync(process.env.AFTERSHOCK_E2E_REPORT, `${report}\n${logger.lines.join('\n')}\n`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}, 60000);

describe('new-code coverage against samples/ImpactSample (coverlet)', () => {
  it('before any change there is no new code: n/a', () => {
    expect(coverage.summary().state).toBe('noNewCode');
    expect(coverage.summary().target).toBe('origin/main');
  });

  it('a new method with a branch and a test for one path: EL 6, LC 5, 2B 2, CT+CF 1 -> 75%, 1 more to 85%', async () => {
    const discount = insertBeforeLastBrace(DISCOUNT, [
      '',
      '    public static decimal ApplyLoyalty(decimal amount, bool isMember)',
      '    {',
      '        if (isMember)',
      '        {',
      '            return amount - 1m;',
      '        }',
      '',
      '        return amount;',
      '    }',
    ]);
    fs.writeFileSync(
      file(LOYALTY_TESTS),
      [
        'using Sample.Core.Discounts;',
        '',
        'namespace Sample.Tests.XUnit;',
        '',
        'public class LoyaltyDiscountTests',
        '{',
        '    [Fact]',
        '    public void Member_GetsOneOff()',
        '    {',
        '        Assert.Equal(9m, DiscountCalculator.ApplyLoyalty(10m, true));',
        '    }',
        '}',
        '',
      ].join('\n'),
    );
    const { runs, plans } = await saveAndWait([discount, file(LOYALTY_TESTS)]);
    expect(runs).toBe(1);
    expect(testsOf(plans)[0]).toContain(MEMBER_TEST);
    const entry = discountFile();
    expect(entry.state).toBe('measured');
    expect(entry.metrics!.counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    expect(entry.metrics!.uncoveredLines).toEqual([lineOf(DISCOUNT, 'return amount;')]);
    expect(entry.metrics!.partialLines.map((p) => [p.line, p.covered, p.total])).toEqual([[lineOf(DISCOUNT, 'if (isMember)'), 1, 2]]);
    const summary = coverage.summary();
    expect(summary.state).toBe('measured');
    expect(summary.counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    expect(summary.tenths).toBe(750);
    expect(summary.needed).toBe(1);
    expect(summary.notMeasured).toBe(0);
    // The test file is new code of a test project: not counted.
    expect(summary.files.map((f) => f.relativePath)).toEqual([`samples/ImpactSample/${DISCOUNT}`]);
    const outcome = outcomes[outcomes.length - 1];
    timings.push(`one path: 75% (6/8), 1 more; run ${formatDuration(outcome.durationMs)}, test phase ${formatDuration(testPhase(outcome))}`);
  });

  it('a second test for the other path: the changed test reaches the file, one follow-up run of all its tests -> 100%', async () => {
    const testFile = edit(
      LOYALTY_TESTS,
      '    }\n}\n',
      ['    }', '', '    [Fact]', '    public void NonMember_PaysFull()', '    {', '        Assert.Equal(10m, DiscountCalculator.ApplyLoyalty(10m, false));', '    }', '}', ''].join('\n'),
    );
    const { runs, plans } = await saveAndWait([testFile]);
    expect(runs).toBe(2);
    const [first, followUp] = testsOf(plans);
    expect(first).toEqual([NON_MEMBER_TEST]);
    expect(followUp).toEqual(expect.arrayContaining([MEMBER_TEST, NON_MEMBER_TEST]));
    expect(logger.lines.some((l) => l.includes('a changed test reached new code of DiscountCalculator.cs'))).toBe(true);
    const entry = discountFile();
    expect(entry.metrics!.counts).toEqual({ coverableLines: 6, coveredLines: 6, conditions: 2, coveredConditions: 2 });
    expect(coverage.summary().tenths).toBe(1000);
    expect(coverage.summary().needed).toBe(0);
    expect(coverage.fileView(file(DISCOUNT))!.metrics.uncoveredLines).toEqual([]);
    timings.push(`other path: 100% after a follow-up run (${followUp.length} tests)`);
  });

  it('saving an unrelated file keeps the first file\'s coverage (not re-run, still correct)', async () => {
    const before = coverage.store.get(file(DISCOUNT))!;
    const hash = before.hash;
    const { plans } = await saveAndWait([edit('src/Sample.Core/Shipping/ExpressShipping.cs', '14.99m', '14.990m')]);
    for (const tests of testsOf(plans)) {
      expect(tests).not.toContain(MEMBER_TEST);
      expect(tests).not.toContain(NON_MEMBER_TEST);
    }
    expect(coverage.store.get(file(DISCOUNT))!.hash).toBe(hash);
    expect(discountFile().metrics!.counts).toEqual({ coverableLines: 6, coveredLines: 6, conditions: 2, coveredConditions: 2 });
    // The unrelated file is new code now and was measured completely by its own run.
    const shipping = coverage.summary().files.find((f) => f.relativePath.endsWith('ExpressShipping.cs'))!;
    expect(shipping.state).toBe('measured');
    expect(shipping.metrics!.counts.coverableLines).toBe(1);
    expect(shipping.metrics!.counts.coveredLines).toBe(1);
    const summary = coverage.summary();
    timings.push(`after an unrelated save: ${summary.tenths! / 10}% overall (lines ${summary.counts.coveredLines}/${summary.counts.coverableLines}, conditions ${summary.counts.coveredConditions}/${summary.counts.conditions})`);
  });

  it('editing another member of the covered file recomputes it with the tests of all its new members', async () => {
    const discount = edit(DISCOUNT, 'return Math.Max(0m, amount - flat);', 'return Math.Max(0m, amount - flat - 0m);');
    const { plans } = await saveAndWait([discount]);
    const all = testsOf(plans).flat();
    // The edit was in ApplyFlat; the loyalty tests run because ApplyLoyalty is new against the target.
    expect(all).toEqual(expect.arrayContaining([MEMBER_TEST, NON_MEMBER_TEST, 'Sample.Tests.XUnit.DiscountTests.Apply_Flat']));
    const entry = discountFile();
    expect(entry.state).toBe('measured');
    expect(entry.metrics!.counts).toEqual({ coverableLines: 7, coveredLines: 7, conditions: 2, coveredConditions: 2 });
  });
});

describe('new-code coverage with Microsoft Code Coverage (VSTest)', () => {
  it('switching the tool invalidates coverlet\'s numbers; Recompute measures everything again', async () => {
    settings.tool = 'microsoft';
    expect(coverage.summary().state).toBe('unknown');
    const before = outcomes.length;
    expect(await orchestrator.enqueue('Recompute new-code coverage', () => coverage.recomputeAll(), { showAnalyzing: true })).toBe(true);
    await settle(before);
    const entry = discountFile();
    expect(entry.state).toBe('measured');
    expect(entry.metrics!.counts).toEqual({ coverableLines: 7, coveredLines: 7, conditions: 2, coveredConditions: 2 });
    const shipping = coverage.summary().files.find((f) => f.relativePath.endsWith('ExpressShipping.cs'))!;
    expect(shipping.state).toBe('measured');
    const summary = coverage.summary();
    timings.push(
      `Microsoft Code Coverage after Recompute: ${summary.tenths! / 10}% (lines ${summary.counts.coveredLines}/${summary.counts.coverableLines}, conditions ${summary.counts.coveredConditions}/${summary.counts.conditions})`,
    );
  });
});

describe('coverage overhead (Run All Tests, warm builds)', () => {
  async function runAll(label: string): Promise<RunOutcome> {
    const before = outcomes.length;
    await orchestrator.runAll();
    await settle(before);
    const outcome = outcomes[outcomes.length - 1];
    expect(outcome.projects.every((p) => p.status === 'passed')).toBe(true);
    const perProject = outcome.projects.map((p) => `${p.plan.name} ${formatDuration(p.durations.test ?? 0)}`).join(', ');
    timings.push(`Run All, ${label}: test phase ${formatDuration(testPhase(outcome))} summed over projects (${perProject}); whole run ${formatDuration(outcome.durationMs)}`);
    return outcome;
  }

  it('without coverage, with coverlet and with Microsoft Code Coverage', async () => {
    settings.enabled = false;
    await runAll('coverage off');
    settings.enabled = true;
    settings.tool = 'coverlet';
    await runAll('coverlet');
    // A run of every test project measures every file completely.
    expect(coverage.summary().notMeasured).toBe(0);
    expect(discountFile().metrics!.counts).toEqual({ coverableLines: 7, coveredLines: 7, conditions: 2, coveredConditions: 2 });
    settings.tool = 'microsoft';
    await runAll('Microsoft Code Coverage');
    expect(coverage.summary().notMeasured).toBe(0);
  });
});
