// End-to-end check of the orchestration core without the VS Code UI: the real analyzer (server mode),
// real dotnet restore/build/test, against a temporary git copy of samples/ImpactSample.
//
//   npm run bundle-analyzer && npm run test:e2e
//
// Needs the .NET SDK (8 or newer), git and NuGet access for the first restore.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAnalyzerDll } from '../../src/core/analyzerLocation';
import { AnalyzerHost } from '../../src/core/analyzerHost';
import { PlanExecutor, type RunOutcome } from '../../src/core/executor';
import { formatDuration, MemoryLogger } from '../../src/core/logger';
import { samePath } from '../../src/core/paths';
import { Orchestrator, type RunSummary } from '../../src/core/orchestrator';
import { dotnetEnvironment, runProcess, type RunOptions } from '../../src/core/processRunner';
import { MemoryStateStore, type ProjectPlan } from '../../src/core/work';

const extensionRoot = path.resolve(__dirname, '..', '..');
const sampleSource = path.resolve(extensionRoot, '..', 'samples', 'ImpactSample');
const DEBOUNCE_MS = 1500;
const verbose = process.env.AFTERSHOCK_E2E_VERBOSE === '1';

// realpath.native: long names instead of Windows 8.3 short names (RUNNER~1), as MSBuild reports them.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aftershock-e2e-')));
const repo = path.join(root, 'repo');
const solutionDir = path.join(repo, 'samples', 'ImpactSample');
const solution = path.join(solutionDir, 'ImpactSample.sln');
const file = (relative: string) => path.join(solutionDir, ...relative.split('/'));

const logger = new MemoryLogger((line) => {
  if (verbose) {
    console.log(line);
  }
});
const timings: string[] = [];
const outcomes: RunOutcome[] = [];
const plansSeen: ProjectPlan[][] = [];
let analyzer: AnalyzerHost;
let orchestrator: Orchestrator;

/** Hook into every dotnet the executor starts (to watch the build's process tree). */
let onDotnetStart: ((args: readonly string[], pid: number) => void) | undefined;

function git(...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=Aftershock E2E', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function edit(relative: string, from: string, to: string): string {
  const target = file(relative);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(from)) {
    throw new Error(`${relative} does not contain ${from}`);
  }
  fs.writeFileSync(target, text.replace(from, to));
  return target;
}

async function saveAndWait(files: string[]): Promise<RunSummary> {
  const before = outcomes.length;
  orchestrator.onSaved(files);
  const end = Date.now() + 300000;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!orchestrator.isBusy && (outcomes.length > before || orchestrator.status.summary?.noTests)) {
      break;
    }
  }
  await orchestrator.whenIdle();
  return orchestrator.status.summary!;
}

const lastPlan = () => plansSeen[plansSeen.length - 1];
const lastOutcome = () => outcomes[outcomes.length - 1];

/** Processes of the group led by `pid` (POSIX) or the tree below `pid` (Windows). */
function processTree(pid: number): number[] {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    const rows = JSON.parse(result.stdout || '[]') as { ProcessId: number; ParentProcessId: number }[];
    const tree = new Set([pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (!tree.has(row.ProcessId) && tree.has(row.ParentProcessId)) {
          tree.add(row.ProcessId);
          grew = true;
        }
      }
    }
    return [...tree].filter((p) => rows.some((r) => r.ProcessId === p));
  }
  // `ps` lists every process with its process group; no pattern matching on command lines.
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' });
  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([p, g]) => g === pid && !Number.isNaN(p))
    .map(([p]) => p);
}

/** Executable names of the given PIDs (for the report). */
function processNames(pids: number[]): string[] {
  if (process.platform === 'win32' || pids.length === 0) {
    return [];
  }
  const result = spawnSync('ps', ['-o', 'comm=', '-p', pids.join(',')], { encoding: 'utf8' });
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function alive(pid: number): boolean {
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
    return result.stdout.includes(` ${pid} `);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

  const restore = await runProcess({ command: 'dotnet', args: ['restore', solution, '-nologo'], cwd: solutionDir, env: dotnetEnvironment() });
  expect(restore.exitCode, restore.output).toBe(0);
  timings.push(`initial dotnet restore of the sample: ${formatDuration(restore.durationMs)}`);

  const started = Date.now();
  analyzer = new AnalyzerHost({ dotnetPath: 'dotnet', analyzerDll: location.dll, solution, options: { maxSymbols: 500, fallbackGlobs: ['**/appsettings*.json'] } }, logger);
  analyzer.start();
  await analyzer.whenReady();
  timings.push(`analyzer ready (load + initialize): ${formatDuration(Date.now() - started)}`);

  const state = new MemoryStateStore();
  const executor = new PlanExecutor({
    solutionDirectory: solutionDir,
    resultsRoot: path.join(root, 'results'),
    state,
    logger,
    settings: () => ({ dotnetPath: 'dotnet', testFilter: '', disableAnalyzersInBuild: true }),
    runProcess: (options: RunOptions) =>
      runProcess({
        ...options,
        onSpawn: (pid) => {
          options.onSpawn?.(pid);
          onDotnetStart?.(options.args, pid);
        },
      }),
  });
  const recording = {
    execute: (plans: readonly ProjectPlan[], signal: AbortSignal, progress: Parameters<PlanExecutor['execute']>[2]) => {
      plansSeen.push(plans.map((p) => ({ ...p, tests: [...p.tests] })));
      return executor.execute(plans, signal, progress);
    },
  };
  orchestrator = new Orchestrator({ analyzer, executor: recording, state, logger, debounceMs: () => DEBOUNCE_MS });
  orchestrator.onRunCompleted((outcome) => outcomes.push(outcome));
}, 600000);

afterAll(async () => {
  orchestrator?.dispose();
  await analyzer?.stop();
  const report = ['', 'Aftershock e2e timings:', ...timings.map((t) => `  ${t}`), ''].join('\n');
  process.stdout.write(report);
  if (process.env.AFTERSHOCK_E2E_REPORT) {
    fs.writeFileSync(process.env.AFTERSHOCK_E2E_REPORT, `${report}\n${logger.lines.join('\n')}\n`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}, 60000);

function describeRun(label: string, summary: RunSummary): void {
  const outcome = lastOutcome();
  const steps = outcome.projects
    .map((p) => `${p.plan.name} [${p.runnerMode}] restore ${formatDuration(p.durations.restore ?? 0)}, build ${formatDuration(p.durations.build ?? 0)}, test ${formatDuration(p.durations.test ?? 0)}`)
    .join('; ');
  timings.push(`${label}: save to result ${formatDuration(summary.durationMs)} (${formatDuration(summary.durationMs - DEBOUNCE_MS)} after the ${DEBOUNCE_MS} ms debounce); ${steps}`);
}

describe('save -> analyze -> build -> test against samples/ImpactSample', () => {
  it('TaxRates change: exactly the 5 impacted xUnit tests are built, run and pass (cold)', async () => {
    const summary = await saveAndWait([edit('src/Sample.Core/Pricing/TaxRates.cs', '"NL" => 0.21m,', '"NL" => 0.215m,')]);
    const plan = lastPlan();
    expect(plan.map((p) => [p.name, p.mode])).toEqual([['Sample.Tests.XUnit', 'filter']]);
    expect(plan[0].tests).toHaveLength(5);
    expect(plan[0].tests.map((t) => t.fullyQualifiedName)).toContain('Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate');
    expect(summary).toMatchObject({ passed: 5, failed: 0, total: 5, buildFailed: [], runFailed: [] });
    expect(lastOutcome().projects[0].runnerMode).toBe('vstest');
    describeRun('TaxRates, first save (restore check, runner mode query, build, test)', summary);
  });

  it('TaxRates change again (warm)', async () => {
    const summary = await saveAndWait([edit('src/Sample.Core/Pricing/TaxRates.cs', '"NL" => 0.215m,', '"NL" => 0.22m,')]);
    expect(lastPlan()[0].tests).toHaveLength(5);
    expect(summary).toMatchObject({ passed: 5, failed: 0, total: 5 });
    expect(lastOutcome().projects[0].durations.restore).toBeUndefined();
    describeRun('TaxRates, second save (warm)', summary);
  });

  it('a broken assertion is reported with the failure message at the test declaration', async () => {
    const testFile = edit('tests/Sample.Tests.XUnit/TaxRatesTests.cs', '[InlineData("TR", 0.20)]', '[InlineData("TR", 0.25)]');
    const summary = await saveAndWait([testFile]);
    expect(lastPlan()[0].tests.map((t) => [t.fullyQualifiedName, t.reason])).toEqual([['Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate', 'changedTest']]);
    expect(summary).toMatchObject({ failed: 1, passed: 0 });
    const [failed] = orchestrator.failed.all();
    expect(failed.fullyQualifiedName).toBe('Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate');
    expect(samePath(failed.file!, testFile), `${failed.file} is ${testFile}`).toBe(true);
    const declaration = fs.readFileSync(testFile, 'utf8').split(/\r?\n/).findIndex((line) => line.includes('void ForCountry_ReturnsRate(')) + 1;
    expect(failed.line).toBe(declaration);
    expect(failed.message).toContain('Assert.Equal() Failure');
    expect(failed.stackTrace).toContain('TaxRatesTests.ForCountry_ReturnsRate');
    expect(failed).toMatchObject({ cases: 3, failedCases: 1 });
    describeRun('broken assertion', summary);
  });

  it('the failed test is re-run with an unrelated change, and cleared once it passes', async () => {
    // ExpressShipping reaches NUnit tests only; the failed xUnit test runs as well.
    const summary = await saveAndWait([edit('src/Sample.Core/Shipping/ExpressShipping.cs', '14.99m', '14.990m')]);
    const plan = lastPlan();
    const xunit = plan.find((p) => p.name === 'Sample.Tests.XUnit');
    expect(xunit?.tests.map((t) => [t.fullyQualifiedName, t.origin])).toContainEqual(['Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate', 'previouslyFailed']);
    expect(plan.some((p) => p.name === 'Sample.Tests.NUnit')).toBe(true);
    expect(summary.failed).toBe(1);
    expect(orchestrator.failed.size).toBe(1);

    const fixed = await saveAndWait([edit('tests/Sample.Tests.XUnit/TaxRatesTests.cs', '[InlineData("TR", 0.25)]', '[InlineData("TR", 0.20)]')]);
    expect(fixed).toMatchObject({ failed: 0, passed: 1 });
    expect(orchestrator.failed.size).toBe(0);
    describeRun('fixed assertion', fixed);
  });

  it('a new save during the build cancels it and leaves no process of the build tree behind', async () => {
    let buildPid: number | undefined;
    onDotnetStart = (args, pid) => {
      if (args[0] === 'build' && buildPid === undefined) {
        buildPid = pid;
      }
    };
    // A declaration change in Sample.Core makes MSBuild compile two projects.
    orchestrator.onSaved([edit('src/Sample.Core/Pricing/TaxRates.cs', '"NL" => 0.22m,', '"NL" => 0.23m,')]);
    const end = Date.now() + 120000;
    while (buildPid === undefined && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(buildPid).toBeDefined();
    // Let MSBuild start its worker nodes and the compiler, then cancel with a new save.
    const settle = Date.now() + 3000;
    while (Date.now() < settle && processTree(buildPid!).length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const treeAtCancel = processTree(buildPid!);
    const names = processNames(treeAtCancel);
    const before = outcomes.length;
    const cancelledAt = Date.now();
    orchestrator.onSaved([edit('src/Sample.Core/Pricing/TaxRates.cs', '"NL" => 0.23m,', '"NL" => 0.21m,')]);
    onDotnetStart = undefined;

    // All processes of the cancelled build disappear quickly.
    const gone = Date.now() + 15000;
    while (treeAtCancel.some(alive) && Date.now() < gone) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const survivors = treeAtCancel.filter(alive);
    timings.push(`cancellation: ${treeAtCancel.length} process(es) in the build tree at cancel${names.length ? ` (${names.join(', ')})` : ''}, all gone after ${formatDuration(Date.now() - cancelledAt)}; survivors: ${survivors.length}`);
    expect(treeAtCancel.length).toBeGreaterThanOrEqual(1);
    expect(survivors).toEqual([]);
    expect(logger.lines.some((l) => l.includes('cancels the running build/test'))).toBe(true);

    // The next run covers the cancelled selection and the new change.
    await orchestrator.whenIdle();
    const endRun = Date.now() + 300000;
    while (outcomes.length === before && Date.now() < endRun) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await orchestrator.whenIdle();
    }
    expect(lastPlan()[0].tests).toHaveLength(5);
    expect(orchestrator.status.summary).toMatchObject({ passed: 5, failed: 0 });
  });

  it('Run All Tests runs all four test projects', async () => {
    const before = outcomes.length;
    await orchestrator.runAll();
    while (outcomes.length === before) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await orchestrator.whenIdle();
    const outcome = lastOutcome();
    expect(outcome.projects.map((p) => [p.plan.name, p.plan.mode, p.status]).sort()).toEqual([
      ['Sample.Tests.MSTest', 'all', 'passed'],
      ['Sample.Tests.NUnit', 'all', 'passed'],
      ['Sample.Tests.XUnit', 'all', 'passed'],
      ['Sample.Tests.XUnitV3', 'all', 'passed'],
    ]);
    const summary = orchestrator.status.summary!;
    expect(summary.failed).toBe(0);
    expect(summary.total).toBeGreaterThan(30);
    timings.push(`Run All Tests: ${summary.total} test methods in ${formatDuration(summary.durationMs)}`);
  });
});
