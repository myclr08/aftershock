import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanExecutor, errorLines, type ExecutorSettings, type RunHooks } from '../../src/core/executor';
import { MemoryLogger } from '../../src/core/logger';
import type { RunOptions, RunResult } from '../../src/core/processRunner';
import { MemoryStateStore, type PlannedTest, type ProjectPlan } from '../../src/core/work';
import { tempDir, writeFile } from './helpers';

const fixtures = path.join(__dirname, '..', 'fixtures', 'trx');

interface Call {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
}

/** Fake dotnet: records commands; `test` drops a TRX fixture where the command asks for it. */
class FakeDotnet {
  readonly calls: Call[] = [];
  properties: Record<string, string> = {};
  buildOutputs: { exitCode: number; output: string }[] = [];
  trx = 'vstest-xunit-failed.trx';
  testExitCode = 1;
  testOutput = '';
  hangOn: string | undefined;

  run = async (options: RunOptions): Promise<RunResult> => {
    const args = [...options.args];
    this.calls.push({ args, cwd: options.cwd, env: options.env });
    const verb = args[0];
    const result = (exitCode: number, output = ''): RunResult => ({ exitCode, signal: null, output, durationMs: 5, cancelled: false, timedOut: false });
    if (this.hangOn === verb) {
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { ...result(137), cancelled: true };
    }
    switch (verb) {
      case 'restore':
        return result(0, 'Restored.');
      case 'msbuild':
        return result(0, JSON.stringify({ Properties: this.properties }));
      case 'build':
        return this.buildOutputs.length > 0 ? result(this.buildOutputs[0].exitCode, this.buildOutputs.shift()!.output) : result(0, 'Build succeeded.');
      case 'test': {
        const flat = args.join(' ');
        const dirIndex = args.findIndex((a) => a === '--results-directory' || a.replace(/"/g, '') === '--results-directory');
        const directory = args[dirIndex + 1].replace(/^"|"$/g, '');
        const vstestName = /LogFileName=([^ ]+\.trx)/.exec(flat)?.[1];
        const mtpName = /--report-(?:xunit-)?trx-filename ([^ ]+)/.exec(flat)?.[1];
        const name = vstestName ?? mtpName;
        if (name) {
          fs.mkdirSync(directory, { recursive: true });
          fs.copyFileSync(path.join(fixtures, this.trx), path.join(directory, name));
        }
        return result(this.testExitCode, this.testOutput);
      }
      default:
        return result(1, `unexpected ${verb}`);
    }
  };

  verbs(): string[] {
    return this.calls.map((c) => c.args[0]);
  }

  last(verb: string): string[] {
    return [...this.calls].reverse().find((c) => c.args[0] === verb)!.args;
  }
}

function planned(fqn: string, framework = 'xunit', parameterized = false): PlannedTest {
  return {
    fullyQualifiedName: fqn,
    className: fqn.slice(0, fqn.lastIndexOf('.')),
    methodName: fqn.slice(fqn.lastIndexOf('.') + 1),
    framework,
    parameterized,
    project: '',
    projectName: '',
    reason: 'referenceChain',
    chain: [],
    origin: 'selected',
  };
}

describe('PlanExecutor', () => {
  let dir: string;
  let cleanup: () => void;
  let project: string;
  let dotnet: FakeDotnet;
  let settings: ExecutorSettings;
  let state: MemoryStateStore;
  let logger: MemoryLogger;
  let hooks: RunHooks[];

  const executor = () =>
    new PlanExecutor({ solutionDirectory: dir, resultsRoot: path.join(dir, 'results'), state, logger, settings: () => settings, runProcess: dotnet.run, hooks });

  const plan = (tests: PlannedTest[], mode: 'all' | 'filter' = 'filter', frameworks = ['xunit']): ProjectPlan => ({
    path: project,
    name: 'Sample.Tests.XUnit',
    frameworks,
    mode,
    reasons: [],
    tests: tests.map((t) => ({ ...t, project, projectName: 'Sample.Tests.XUnit' })),
  });

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    project = path.join(dir, 'tests', 'Sample.Tests.XUnit', 'Sample.Tests.XUnit.csproj');
    writeFile(project, '<Project Sdk="Microsoft.NET.Sdk" />', Date.now() - 60000);
    writeFile(path.join(dir, 'tests', 'Sample.Tests.XUnit', 'obj', 'project.assets.json'), '{}');
    dotnet = new FakeDotnet();
    settings = { dotnetPath: 'dotnet', testFilter: '', disableAnalyzersInBuild: true };
    state = new MemoryStateStore();
    logger = new MemoryLogger();
    hooks = [];
  });

  afterEach(() => cleanup());

  it('VSTest: restore on the first run, build, filtered test with TRX; no restore the second time', async () => {
    const run = executor();
    const progress: string[] = [];
    const outcome = await run.execute([plan([planned('Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate')])], new AbortController().signal, (p) => progress.push(p.phase));
    expect(dotnet.verbs()).toEqual(['restore', 'msbuild', 'build', 'test']);
    expect(dotnet.last('build')).toEqual(['build', project, '--no-restore', '-m', '-nologo', '-p:RunAnalyzers=false', '-p:TreatWarningsAsErrors=false']);
    const test = dotnet.last('test');
    expect(test.slice(0, 5)).toEqual(['test', project, '--no-build', '--nologo', '--logger']);
    expect(test[5]).toMatch(/^trx;LogFileName=Sample\.Tests\.XUnit-1\.trx$/);
    expect(test.slice(6, 7)).toEqual(['--results-directory']);
    expect(test.slice(8)).toEqual(['--filter', 'FullyQualifiedName=Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate']);
    expect(dotnet.calls.every((c) => c.cwd === dir && c.env?.MSBUILDDISABLENODEREUSE === '1' && c.env?.DOTNET_CLI_USE_MSBUILD_SERVER === '0')).toBe(true);
    expect(progress).toEqual(['restoring', 'building', 'testing']);

    const [project0] = outcome.projects;
    expect(project0.status).toBe('failed');
    expect(project0.runnerMode).toBe('vstest');
    expect(project0.results.map((r) => [r.fullyQualifiedName, r.outcome])).toEqual([['Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate', 'failed']]);
    expect(logger.lines.some((l) => l.includes('> dotnet build'))).toBe(true);

    dotnet.calls.length = 0;
    await run.execute([plan([planned('Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate')])], new AbortController().signal);
    expect(dotnet.verbs()).toEqual(['build', 'test']);
  });

  it('restores again after the project file changed, and keeps analyzers on when asked', async () => {
    const run = executor();
    await run.execute([plan([planned('A.B.C')])], new AbortController().signal);
    writeFile(project, '<Project Sdk="Microsoft.NET.Sdk"><!-- changed --></Project>', Date.now() + 5000);
    settings.disableAnalyzersInBuild = false;
    dotnet.calls.length = 0;
    await run.execute([plan([planned('A.B.C')])], new AbortController().signal);
    expect(dotnet.verbs()).toEqual(['restore', 'msbuild', 'build', 'test']);
    expect(dotnet.last('build')).not.toContain('-p:RunAnalyzers=false');
    expect(dotnet.last('build')).toContain('-p:TreatWarningsAsErrors=false');
  });

  it('combines the user filter and runs whole projects with only the user filter', async () => {
    settings.testFilter = 'Category!=Integration';
    const run = executor();
    await run.execute([plan([planned('A.B.C')])], new AbortController().signal);
    expect(dotnet.last('test').slice(-2)).toEqual(['--filter', '(FullyQualifiedName=A.B.C)&(Category!=Integration)']);
    await run.execute([plan([], 'all')], new AbortController().signal);
    expect(dotnet.last('test').slice(-2)).toEqual(['--filter', 'Category!=Integration']);
    settings.testFilter = '';
    await run.execute([plan([], 'all')], new AbortController().signal);
    expect(dotnet.last('test')).not.toContain('--filter');
  });

  it('splits long selections into batches, one dotnet test each', async () => {
    settings.maxFilterLength = 120;
    const tests = Array.from({ length: 6 }, (_, i) => planned(`Company.Product.Feature${i}Tests.Method`));
    const outcome = await executor().execute([plan(tests)], new AbortController().signal);
    const testCalls = dotnet.calls.filter((c) => c.args[0] === 'test');
    expect(testCalls.length).toBeGreaterThan(1);
    for (const call of testCalls) {
      expect(call.args[call.args.length - 1].length).toBeLessThanOrEqual(120);
    }
    expect(outcome.projects[0].status).toBe('failed');
    expect(logger.lines.some((l) => l.includes('selecting whole classes in'))).toBe(true);
  });

  it('bridge mode: xUnit v3 options after --, quoted where needed, xUnit TRX report', async () => {
    dotnet.properties = { IsTestingPlatformApplication: 'true', TestingPlatformDotnetTestSupport: 'true', UseMicrosoftTestingPlatformRunner: 'true' };
    dotnet.trx = 'mtp-xunitv3-failed.trx';
    settings.testFilter = 'Category!=Slow Tests';
    hooks.push({ testArguments: (context) => (context.runnerMode === 'bridge' ? ['--coverage'] : []) });
    const outcome = await executor().execute([plan([planned('Sample.Tests.XUnitV3.MoneyV3Tests.Add_ReturnsSum', 'xunit', true)])], new AbortController().signal);
    const test = dotnet.last('test');
    const separator = test.indexOf('--');
    expect(test.slice(0, separator)).toEqual(['test', project, '--no-build', '--nologo']);
    const appArgs = test.slice(separator + 1);
    expect(appArgs.slice(0, 4)).toEqual(['--filter-method', 'Sample.Tests.XUnitV3.MoneyV3Tests.Add_ReturnsSum', '--filter-not-trait', '"Category=Slow Tests"']);
    expect(appArgs).toContain('--report-xunit-trx');
    expect(appArgs[appArgs.length - 1]).toBe('--coverage');
    expect(outcome.projects[0].runnerMode).toBe('bridge');
    expect(outcome.projects[0].results.find((r) => r.outcome === 'failed')?.fullyQualifiedName).toBe('Sample.Tests.XUnitV3.MoneyV3Tests.Add_ReturnsSum');
  });

  it('MTP mode (global.json): dotnet test --project with the framework options', async () => {
    writeFile(path.join(dir, 'global.json'), '{ "test": { "runner": "Microsoft.Testing.Platform" } }');
    dotnet.trx = 'mtp-nunit-failed.trx';
    dotnet.testExitCode = 2;
    const outcome = await executor().execute([plan([planned('Sample.Tests.NUnit.ExpressCostCaseTests.Cost_ByQuantity', 'nunit', true)], 'filter', ['nunit'])], new AbortController().signal);
    expect(dotnet.verbs()).toEqual(['restore', 'build', 'test']); // no property query in MTP mode
    const test = dotnet.last('test');
    expect(test.slice(0, 4)).toEqual(['test', '--project', project, '--no-build']);
    expect(test.slice(4, 6)).toEqual(['--filter', 'FullyQualifiedName~Sample.Tests.NUnit.ExpressCostCaseTests.Cost_ByQuantity']);
    expect(test.slice(6, 9)).toEqual(['--report-trx', '--report-trx-filename', 'Sample.Tests.XUnit-1.trx']);
    expect(outcome.projects[0].status).toBe('failed');
    expect(outcome.projects[0].runnerMode).toBe('mtp');
  });

  it('MTP without a TRX extension falls back to the console output', async () => {
    writeFile(path.join(dir, 'global.json'), '{ "test": { "runner": "Microsoft.Testing.Platform" } }');
    dotnet.trx = 'none';
    let first = true;
    const original = dotnet.run;
    dotnet.run = async (options) => {
      if (options.args[0] === 'test') {
        dotnet.calls.push({ args: [...options.args], cwd: options.cwd, env: options.env });
        if (first) {
          first = false;
          return { exitCode: 5, signal: null, output: "Unknown option '--report-trx'", durationMs: 1, cancelled: false, timedOut: false };
        }
        return { exitCode: 2, signal: null, output: 'failed Reset_ClearsPoints (8ms)\n  Assert.AreEqual failed.\n', durationMs: 1, cancelled: false, timedOut: false };
      }
      return original(options);
    };
    const tests = [planned('Sample.Tests.MSTest.LoyaltyServiceTests.Reset_ClearsPoints', 'mstest'), planned('Sample.Tests.MSTest.LoyaltyServiceTests.CanRedeem', 'mstest')];
    const outcome = await executor().execute([plan(tests, 'filter', ['mstest'])], new AbortController().signal);
    expect(dotnet.calls.filter((c) => c.args[0] === 'test')).toHaveLength(2);
    expect(dotnet.last('test')).not.toContain('--report-trx');
    expect(outcome.projects[0].results.map((r) => [r.methodName, r.outcome])).toEqual([
      ['CanRedeem', 'passed'],
      ['Reset_ClearsPoints', 'failed'],
    ]);
  });

  it('reports a failed build with its errors and runs no tests', async () => {
    dotnet.buildOutputs.push({ exitCode: 1, output: '/x/A.cs(3,5): error CS1002: ; expected [/x/A.csproj]\n/x/A.cs(3,5): error CS1002: ; expected [/x/A.csproj]\nBuild FAILED.' });
    const outcome = await executor().execute([plan([planned('A.B.C')])], new AbortController().signal);
    expect(outcome.projects[0].status).toBe('buildFailed');
    expect(outcome.projects[0].details).toEqual(['/x/A.cs(3,5): error CS1002: ; expected [/x/A.csproj]']);
    expect(dotnet.verbs()).not.toContain('test');
  });

  it('restores and builds again when the build reports missing restore output', async () => {
    const run = executor();
    await run.execute([plan([planned('A.B.C')])], new AbortController().signal);
    dotnet.calls.length = 0;
    dotnet.buildOutputs.push({ exitCode: 1, output: "error NETSDK1004: Assets file '/x/obj/project.assets.json' not found." });
    const outcome = await run.execute([plan([planned('A.B.C')])], new AbortController().signal);
    expect(dotnet.verbs()).toEqual(['build', 'restore', 'build', 'test']);
    expect(outcome.projects[0].status).toBe('failed');
  });

  it('reports a test run that produced no results', async () => {
    dotnet.trx = 'none';
    const original = dotnet.run;
    dotnet.run = async (options: RunOptions) => {
      if (options.args[0] === 'test') {
        return { exitCode: 1, signal: null, output: 'Testhost process exited with error: crash', durationMs: 1, cancelled: false, timedOut: false };
      }
      return original(options);
    };
    const outcome = await executor().execute([plan([planned('A.B.C')])], new AbortController().signal);
    expect(outcome.projects[0].status).toBe('testRunFailed');
    expect(outcome.projects[0].details).toContain('Testhost process exited with error: crash');
  });

  it('stops at once when cancelled during the build', async () => {
    dotnet.hangOn = 'build';
    const controller = new AbortController();
    const running = executor().execute([plan([planned('A.B.C')])], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const outcome = await running;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.projects[0].status).toBe('cancelled');
    expect(dotnet.verbs()).not.toContain('test');
  });

  it('keeps only the newest result folders', async () => {
    const run = executor();
    for (let i = 0; i < 7; i++) {
      await run.execute([plan([planned('A.B.C')])], new AbortController().signal);
    }
    expect(fs.readdirSync(path.join(dir, 'results')).filter((n) => n.startsWith('run-')).length).toBeLessThanOrEqual(5);
  });

  it('extracts distinct compiler errors', () => {
    expect(errorLines('a\n  /x.cs(1,1): error CS0103: The name x does not exist\nb\n/x.cs(1,1): error CS0103: The name x does not exist')).toEqual(['/x.cs(1,1): error CS0103: The name x does not exist']);
    expect(errorLines('nothing useful\nlast line')).toEqual(['nothing useful', 'last line']);
  });
});
