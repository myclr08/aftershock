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

/**
 * Extra environment for `dotnet build` while the cancellation test wants a build that cannot finish
 * on its own (see writeSleepTargets). Undefined for every other build.
 */
let slowBuildEnvironment: NodeJS.ProcessEnv | undefined;

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

interface ProcessInfo {
  pid: number;
  name: string;
}

/**
 * One snapshot of the processes in the group led by `pid` (POSIX) or in the tree below `pid`
 * (Windows). On Windows this starts PowerShell (a cold start takes seconds on CI), so callers take it
 * once, while the tree is known to be stable, and never poll it.
 */
function processTree(pid: number): ProcessInfo[] {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`Win32_Process snapshot failed (${result.status ?? result.error?.message}): ${result.stderr}`);
    }
    const rows = JSON.parse(result.stdout) as { ProcessId: number; ParentProcessId: number; Name: string }[];
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
    return rows.filter((row) => tree.has(row.ProcessId)).map((row) => ({ pid: row.ProcessId, name: row.Name }));
  }
  // `ps` lists every process with its process group; no pattern matching on command lines.
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,comm='], { encoding: 'utf8' });
  const tree: ProcessInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === pid) {
      tree.push({ pid: Number(match[1]), name: match[3].trim() });
    }
  }
  return tree;
}

/** The given processes that still run. Windows: one `tasklist` call, the name guards against PID reuse. */
function stillRunning(processes: readonly ProcessInfo[]): ProcessInfo[] {
  if (processes.length === 0) {
    return [];
  }
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const running = new Map<number, string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^"([^"]*)","(\d+)"/.exec(line);
      if (match) {
        running.set(Number(match[2]), match[1].toLowerCase());
      }
    }
    if (result.status !== 0 || running.size === 0) {
      throw new Error(`tasklist failed (${result.status ?? result.error?.message}): ${result.stderr}`);
    }
    return processes.filter((p) => running.get(p.pid) === p.name.toLowerCase());
  }
  return processes.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  });
}

/** Cleanup after a failed assertion only; the code under test does the real tree kill. */
function forceKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * MSBuild imports `$(CustomAfterMicrosoftCommonTargets)` into every project when it is set (here: as
 * an environment variable of a single `dotnet build`), so the sample repository stays untouched and
 * the analyzer never sees a changed build file. After the compiler ran, the build waits for a sleeping
 * grandchild that writes its own PID to `$AFTERSHOCK_E2E_SLEEPER_PID`; a cancellation then always
 * meets a live build tree, however fast the machine compiles.
 */
function writeSleepTargets(target: string): void {
  const windows = 'powershell.exe -NoProfile -NonInteractive -Command &quot;Set-Content -LiteralPath $env:AFTERSHOCK_E2E_SLEEPER_PID -Value $PID; Start-Sleep -Seconds 60&quot;';
  const posix = 'echo $$ &gt; &quot;$AFTERSHOCK_E2E_SLEEPER_PID&quot;; exec sleep 60';
  fs.writeFileSync(
    target,
    [
      '<Project>',
      '  <Target Name="AftershockE2ESleep" AfterTargets="CoreCompile">',
      `    <Exec Condition="'$(OS)' == 'Windows_NT'" Command="${windows}" />`,
      `    <Exec Condition="'$(OS)' != 'Windows_NT'" Command="${posix}" />`,
      '  </Target>',
      '</Project>',
      '',
    ].join('\n'),
  );
}

/** The PID a sleeper wrote, once its line is complete (echo and Set-Content both end it). */
function readPid(file: string): number | undefined {
  try {
    const match = /^\uFEFF?(\d+)\r?\n/.exec(fs.readFileSync(file, 'utf8'));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
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
        env: slowBuildEnvironment && options.args[0] === 'build' ? { ...options.env, ...slowBuildEnvironment } : options.env,
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
    // The sample compiles in about two seconds, faster than a process snapshot on Windows: this build
    // waits in a sleeping grandchild instead, so the cancellation always has a live tree to kill.
    const targets = path.join(root, 'aftershock-e2e-sleep.targets');
    const sleeperPidFile = path.join(root, 'sleeper.pid');
    writeSleepTargets(targets);
    fs.rmSync(sleeperPidFile, { force: true });
    slowBuildEnvironment = { CustomAfterMicrosoftCommonTargets: targets, AFTERSHOCK_E2E_SLEEPER_PID: sleeperPidFile };
    let buildPid: number | undefined;
    let sleeperPid: number | undefined;
    let treeAtCancel: ProcessInfo[] = [];
    onDotnetStart = (args, pid) => {
      if (args[0] === 'build' && buildPid === undefined) {
        buildPid = pid;
      }
    };
    try {
      // A declaration change in Sample.Core makes MSBuild compile two projects.
      orchestrator.onSaved([edit('src/Sample.Core/Pricing/TaxRates.cs', '"NL" => 0.22m,', '"NL" => 0.23m,')]);
      const end = Date.now() + 120000;
      while ((buildPid === undefined || sleeperPid === undefined) && orchestrator.isBusy && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        sleeperPid = readPid(sleeperPidFile);
      }
      expect(buildPid, 'the build did not start').toBeDefined();
      expect(sleeperPid, 'the build did not reach the sleeping child').toBeDefined();
      // The build now waits for the sleeper (60 s), so one snapshot shows the tree as the kill meets it.
      treeAtCancel = processTree(buildPid!);
      slowBuildEnvironment = undefined;
      const before = outcomes.length;
      const cancelledAt = Date.now();
      orchestrator.onSaved([edit('src/Sample.Core/Pricing/TaxRates.cs', '"NL" => 0.23m,', '"NL" => 0.21m,')]);
      onDotnetStart = undefined;

      // All processes of the cancelled build, the sleeper included, disappear quickly.
      const gone = Date.now() + 15000;
      let survivors = stillRunning(treeAtCancel);
      while (survivors.length > 0 && Date.now() < gone) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        survivors = stillRunning(treeAtCancel);
      }
      const names = treeAtCancel.map((p) => p.name).join(', ');
      timings.push(`cancellation: ${treeAtCancel.length} process(es) in the build tree at cancel (${names}), all gone after ${formatDuration(Date.now() - cancelledAt)}; survivors: ${survivors.length}`);
      const pids = treeAtCancel.map((p) => p.pid);
      expect(pids, `build tree: ${names}`).toContain(buildPid);
      expect(pids, `build tree: ${names}`).toContain(sleeperPid);
      expect(treeAtCancel.length).toBeGreaterThanOrEqual(2);
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
    } finally {
      slowBuildEnvironment = undefined;
      onDotnetStart = undefined;
      // Only after a failure: nothing of this build may outlive the test (the sleeper would for 60 s),
      // also not a sleeper that escaped the tree.
      const watched = [...treeAtCancel];
      if (sleeperPid !== undefined && !watched.some((p) => p.pid === sleeperPid)) {
        watched.push({ pid: sleeperPid, name: process.platform === 'win32' ? 'powershell.exe' : 'sleep' });
      }
      try {
        stillRunning(watched).forEach((p) => forceKill(p.pid));
      } catch {
        // Keep the test's own failure.
      }
    }
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
