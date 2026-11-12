import { afterEach, describe, expect, it } from 'vitest';
import type { ImpactReport, ImpactTest, WorkspaceTestProject } from '../../src/core/analyzerProtocol';
import type { ExecutorProgress, ProjectOutcome, RunOutcome } from '../../src/core/executor';
import { RpcError } from '../../src/core/jsonRpc';
import { MemoryLogger } from '../../src/core/logger';
import type { CoverageParticipant } from '../../src/core/coverage';
import { Orchestrator, type ImpactSource, type OrchestratorStatus, type PlanRunner } from '../../src/core/orchestrator';
import type { TestMethodResult } from '../../src/core/trx';
import { MemoryStateStore, type ProjectPlan } from '../../src/core/work';

const PROJECT = '/repo/tests/App.Tests/App.Tests.csproj';
const OTHER = '/repo/tests/Other.Tests/Other.Tests.csproj';

function test(name: string, project = PROJECT): ImpactTest {
  return {
    fullyQualifiedName: `App.Tests.${name}`,
    className: `App.Tests.${name.split('.')[0]}`,
    methodName: name.split('.')[1],
    framework: 'xunit',
    parameterized: false,
    project,
    projectName: project === PROJECT ? 'App.Tests' : 'Other.Tests',
    file: `/repo/tests/${name.split('.')[0]}.cs`,
    line: 10,
    reason: 'referenceChain',
    chain: ['Changed.Member', name],
  };
}

function report(tests: ImpactTest[], extra: Partial<ImpactReport> = {}): ImpactReport {
  const projects = [...new Set(tests.map((t) => t.project))];
  return {
    schemaVersion: 1,
    solution: '/repo/App.sln',
    repositoryRoot: '/repo',
    durationsMs: { total: 3 },
    changedFiles: [{ path: 'src/A.cs', fullPath: '/repo/src/A.cs', status: 'modified', analysis: 'selective' }],
    changedSymbols: [],
    fallback: null,
    tests,
    testProjects: projects.map((p) => ({ name: p === PROJECT ? 'App.Tests' : 'Other.Tests', path: p, mode: 'filter', tests: 1, frameworks: ['xunit'] })),
    diagnostics: [],
    ...extra,
  };
}

interface PendingImpact {
  files: readonly string[];
  resolve(report: ImpactReport): void;
  reject(error: Error): void;
}

class FakeAnalyzer implements ImpactSource {
  readonly requests: PendingImpact[] = [];
  auto: ((files: readonly string[]) => ImpactReport) | undefined;
  testProjects: WorkspaceTestProject[] | undefined = [
    { name: 'App.Tests', path: PROJECT, frameworks: ['xunit'] },
    { name: 'Other.Tests', path: OTHER, frameworks: ['nunit'] },
  ];

  impact(files: readonly string[]): Promise<ImpactReport> {
    if (this.auto) {
      return Promise.resolve(this.auto(files));
    }
    return new Promise((resolve, reject) => this.requests.push({ files, resolve, reject }));
  }

  whenReady(): Promise<unknown> {
    return Promise.resolve();
  }
}

class FakeExecutor implements PlanRunner {
  readonly calls: ProjectPlan[][] = [];
  /** Test FQNs that fail. */
  failing = new Set<string>();
  /** Project names whose build fails. */
  brokenBuilds = new Set<string>();
  private release: (() => void) | undefined;
  blocked = false;

  unblock(): void {
    this.blocked = false;
    this.release?.();
  }

  async execute(plans: readonly ProjectPlan[], signal: AbortSignal, progress: (p: ExecutorProgress) => void): Promise<RunOutcome> {
    this.calls.push(plans.map((p) => ({ ...p, tests: [...p.tests] })));
    progress({ phase: 'building', project: plans[0].name, index: 1, count: plans.length });
    if (this.blocked) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    if (signal.aborted) {
      return { projects: plans.map((plan) => ({ plan, status: 'cancelled', results: [], durations: {} })), cancelled: true, durationMs: 1 };
    }
    progress({ phase: 'testing', tests: plans.reduce((n, p) => n + p.tests.length, 0), projects: plans.length });
    const projects: ProjectOutcome[] = plans.map((plan) => {
      if (this.brokenBuilds.has(plan.name)) {
        return { plan, status: 'buildFailed', results: [], durations: {}, message: 'CS1002' };
      }
      const names = plan.mode === 'all' ? [`App.Tests.All.One`, ...plan.tests.map((t) => t.fullyQualifiedName)] : plan.tests.map((t) => t.fullyQualifiedName);
      const results: TestMethodResult[] = [...new Set(names)].map((fqn) => ({
        className: fqn.slice(0, fqn.lastIndexOf('.')),
        methodName: fqn.slice(fqn.lastIndexOf('.') + 1),
        fullyQualifiedName: fqn,
        outcome: this.failing.has(fqn) ? 'failed' : 'passed',
        cases: 1,
        failedCases: this.failing.has(fqn) ? 1 : 0,
        message: this.failing.has(fqn) ? 'Assert.Equal() Failure' : undefined,
        stackTrace: this.failing.has(fqn) ? '   at App.Tests.X.Y() in /repo/tests/X.cs:line 12' : undefined,
        durationMs: 1,
      }));
      return { plan, status: results.some((r) => r.outcome === 'failed') ? 'failed' : 'passed', results, durations: {} };
    });
    return { projects, cancelled: false, durationMs: 1 };
  }
}

const orchestrators: Orchestrator[] = [];

function setup(state = new MemoryStateStore(), coverage?: CoverageParticipant) {
  const analyzer = new FakeAnalyzer();
  const executor = new FakeExecutor();
  const logger = new MemoryLogger();
  const statuses: OrchestratorStatus[] = [];
  const orchestrator = new Orchestrator({ analyzer, executor, state, logger, debounceMs: () => 30, coverage });
  orchestrator.onStatus((s) => statuses.push(s));
  orchestrators.push(orchestrator);
  return { analyzer, executor, logger, orchestrator, state, statuses };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error('timed out');
    }
    await tick(5);
  }
}

const fqns = (plans: ProjectPlan[]) => plans.flatMap((p) => p.tests.map((t) => t.fullyQualifiedName)).sort();

afterEach(() => {
  orchestrators.splice(0).forEach((o) => o.dispose());
});

describe('Orchestrator', () => {
  it('debounces saves into one impact request and runs the selection', async () => {
    const { analyzer, executor, orchestrator } = setup();
    orchestrator.onSaved(['/repo/src/A.cs']);
    await tick(10);
    orchestrator.onSaved(['/repo/src/B.cs']);
    orchestrator.onSaved(['/repo/src/A.cs']);
    expect(orchestrator.status.phase).toBe('analyzing');
    await until(() => analyzer.requests.length === 1);
    expect([...analyzer.requests[0].files].sort()).toEqual(['/repo/src/A.cs', '/repo/src/B.cs']);
    analyzer.requests[0].resolve(report([test('PriceTests.Total')]));
    await orchestrator.whenIdle();
    expect(executor.calls).toHaveLength(1);
    expect(fqns(executor.calls[0])).toEqual(['App.Tests.PriceTests.Total']);
    expect(orchestrator.status.phase).toBe('done');
    expect(orchestrator.status.summary).toMatchObject({ passed: 1, failed: 0, total: 1 });
  });

  it('a new save cancels the running build/test; the cancelled selection runs with the next one', async () => {
    const { analyzer, executor, orchestrator, logger } = setup();
    executor.blocked = true;
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => analyzer.requests.length === 1);
    analyzer.requests[0].resolve(report([test('ATests.One')]));
    await until(() => executor.calls.length === 1);
    expect(orchestrator.status.phase).toBe('building');

    orchestrator.onSaved(['/repo/src/B.cs']);
    expect(logger.lines.some((l) => l.includes('cancels the running build/test'))).toBe(true);
    executor.blocked = false;
    await until(() => analyzer.requests.length === 2);
    analyzer.requests[1].resolve(report([test('BTests.Two')]));
    await orchestrator.whenIdle();
    expect(executor.calls).toHaveLength(2);
    expect(fqns(executor.calls[1])).toEqual(['App.Tests.ATests.One', 'App.Tests.BTests.Two']);
    expect(orchestrator.status.summary?.total).toBe(2);
  });

  it('uses the result of a request it meant to supersede (its snapshot advanced)', async () => {
    const { analyzer, executor, orchestrator } = setup();
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => analyzer.requests.length === 1);
    orchestrator.onSaved(['/repo/src/B.cs']);
    await until(() => analyzer.requests.length === 2);
    // The first request had already finished in the analyzer: it still returns its result.
    analyzer.requests[0].resolve(report([test('ATests.One')]));
    await tick(20);
    expect(executor.calls).toHaveLength(0); // the newer request is still running
    analyzer.requests[1].resolve(report([test('BTests.Two')]));
    await orchestrator.whenIdle();
    expect(executor.calls).toHaveLength(1);
    expect(fqns(executor.calls[0])).toEqual(['App.Tests.ATests.One', 'App.Tests.BTests.Two']);
  });

  it('a superseded request (-32800) is not a failure', async () => {
    const { analyzer, executor, orchestrator, logger } = setup();
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => analyzer.requests.length === 1);
    orchestrator.onSaved(['/repo/src/B.cs']);
    await until(() => analyzer.requests.length === 2);
    analyzer.requests[0].reject(new RpcError(-32800, 'impact: superseded', { reason: 'superseded', by: 2 }));
    analyzer.requests[1].resolve(report([test('ATests.One'), test('BTests.Two')]));
    await orchestrator.whenIdle();
    expect(executor.calls).toHaveLength(1);
    expect(logger.lines.some((l) => l.startsWith('[error]') || l.includes('analysis failed'))).toBe(false);
  });

  it('re-runs previously failed tests until they pass, also after a reload', async () => {
    const state = new MemoryStateStore();
    const first = setup(state);
    first.analyzer.auto = (files) => (files.includes('/repo/src/A.cs') ? report([test('ATests.One')]) : report([test('BTests.Two')]));
    first.executor.failing.add('App.Tests.ATests.One');
    first.orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => first.executor.calls.length === 1);
    await first.orchestrator.whenIdle();
    expect(first.orchestrator.status.summary).toMatchObject({ failed: 1 });
    expect(first.orchestrator.failed.all().map((t) => [t.fullyQualifiedName, t.message])).toEqual([['App.Tests.ATests.One', 'Assert.Equal() Failure']]);
    first.orchestrator.dispose();

    // A new session (window reload) with the same workspace state.
    const second = setup(state);
    second.analyzer.auto = () => report([test('BTests.Two')]);
    second.executor.failing.add('App.Tests.ATests.One');
    second.orchestrator.onSaved(['/repo/src/B.cs']);
    await until(() => second.executor.calls.length === 1);
    await second.orchestrator.whenIdle();
    const planned = second.executor.calls[0][0].tests.map((t) => [t.fullyQualifiedName, t.origin]);
    expect(planned).toEqual([
      ['App.Tests.ATests.One', 'previouslyFailed'],
      ['App.Tests.BTests.Two', 'selected'],
    ]);

    // Fixed: it passes and leaves the failed set.
    second.executor.failing.clear();
    second.orchestrator.onSaved(['/repo/src/B.cs']);
    await until(() => second.executor.calls.length === 2);
    await second.orchestrator.whenIdle();
    expect(second.orchestrator.failed.size).toBe(0);
    expect(second.logger.lines.some((l) => l.includes('ATests.One passes again'))).toBe(true);

    second.orchestrator.onSaved(['/repo/src/B.cs']);
    await until(() => second.executor.calls.length === 3);
    await second.orchestrator.whenIdle();
    expect(fqns(second.executor.calls[2])).toEqual(['App.Tests.BTests.Two']);
  });

  it('forgets a previously failed test that no longer produces a result', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.auto = () => report([test('ATests.One')]);
    executor.failing.add('App.Tests.ATests.One');
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(orchestrator.failed.size).toBe(1);

    // The test was deleted: the executor returns nothing for it.
    analyzer.auto = () => report([test('BTests.Two')]);
    const original = executor.execute.bind(executor);
    executor.execute = async (plans, signal, progress) => {
      const outcome = await original(plans, signal, progress);
      outcome.projects.forEach((p) => (p.results = p.results.filter((r) => r.fullyQualifiedName !== 'App.Tests.ATests.One')));
      return outcome;
    };
    orchestrator.onSaved(['/repo/src/B.cs']);
    await until(() => executor.calls.length === 2);
    await orchestrator.whenIdle();
    expect(orchestrator.failed.size).toBe(0);
  });

  it('waits for the debug session to end before building', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.auto = () => report([test('ATests.One')]);
    orchestrator.setGate('debug', true);
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => orchestrator.status.phase === 'waitingForDebug');
    await tick(60);
    expect(executor.calls).toHaveLength(0);
    orchestrator.setGate('debug', false);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(orchestrator.status.phase).toBe('done');
  });

  it('a debug session that starts during a build cancels it and runs it again afterwards', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.auto = () => report([test('ATests.One')]);
    executor.blocked = true;
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => executor.calls.length === 1);
    orchestrator.setGate('debug', true);
    await until(() => orchestrator.status.phase === 'waitingForDebug');
    executor.blocked = false;
    orchestrator.setGate('debug', false);
    await until(() => executor.calls.length === 2);
    await orchestrator.whenIdle();
    expect(fqns(executor.calls[1])).toEqual(['App.Tests.ATests.One']);
    expect(orchestrator.status.summary?.passed).toBe(1);
  });

  it('pause keeps the work until resume', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.auto = () => report([test('ATests.One')]);
    orchestrator.setGate('paused', true);
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => orchestrator.status.phase === 'paused');
    expect(executor.calls).toHaveLength(0);
    orchestrator.setGate('paused', false);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
  });

  it('runs every test project when the analysis fails', async () => {
    const { analyzer, executor, orchestrator } = setup();
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => analyzer.requests.length === 1);
    analyzer.requests[0].reject(new Error('the analyzer stopped (exit code 134)'));
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(executor.calls[0].map((p) => [p.name, p.mode])).toEqual([
      ['App.Tests', 'all'],
      ['Other.Tests', 'all'],
    ]);
    expect(executor.calls[0][0].reasons[0]).toContain('analysis failed');
    expect(orchestrator.status.fallbackReasons[0]).toContain('analysis failed');
  });

  it('keeps the selection after a failed build and runs it with the next change', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.auto = (files) => report([test(files[0].includes('A') ? 'ATests.One' : 'BTests.Two')]);
    executor.brokenBuilds.add('App.Tests');
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(orchestrator.status.summary?.buildFailed).toEqual(['App.Tests']);
    await tick(60);
    expect(executor.calls).toHaveLength(1); // not retried by itself

    executor.brokenBuilds.clear();
    orchestrator.onSaved(['/repo/src/B.cs']);
    await until(() => executor.calls.length === 2);
    await orchestrator.whenIdle();
    expect(fqns(executor.calls[1])).toEqual(['App.Tests.ATests.One', 'App.Tests.BTests.Two']);
  });

  it('marks fallback projects to run completely, with the reason', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.auto = () =>
      report([test('ATests.One')], {
        fallback: { reasons: [{ kind: 'buildFile', file: 'tests/Other.Tests/Other.Tests.csproj', message: 'project file changed', testProjects: [OTHER] }], testProjects: [OTHER] },
        testProjects: [
          { name: 'App.Tests', path: PROJECT, mode: 'filter', tests: 1, frameworks: ['xunit'] },
          { name: 'Other.Tests', path: OTHER, mode: 'all', tests: 0, frameworks: ['nunit'] },
        ],
      });
    orchestrator.onSaved(['/repo/tests/Other.Tests/Other.Tests.csproj']);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(executor.calls[0].map((p) => [p.name, p.mode])).toEqual([
      ['App.Tests', 'filter'],
      ['Other.Tests', 'all'],
    ]);
    expect(orchestrator.status.fallbackReasons).toEqual(['[buildFile] tests/Other.Tests/Other.Tests.csproj: project file changed']);
    expect(orchestrator.lastSelection.map((e) => [e.projectName, e.test?.fullyQualifiedName, e.outcome])).toEqual([
      ['App.Tests', 'App.Tests.ATests.One', 'passed'],
      ['Other.Tests', undefined, undefined],
    ]);
  });

  it('Run All Tests runs every test project completely and clears the pending selection', async () => {
    const { executor, orchestrator } = setup();
    await orchestrator.runAll();
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(executor.calls[0].map((p) => [p.name, p.mode, p.reasons])).toEqual([
      ['App.Tests', 'all', ['Run All Tests']],
      ['Other.Tests', 'all', ['Run All Tests']],
    ]);
    expect(orchestrator.status.phase).toBe('done');
  });

  it('ignores saves that change nothing relevant, but re-runs failed tests on a real save without selection', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.auto = () => report([], { changedFiles: [{ path: '.vscode/settings.json', fullPath: '/repo/.vscode/settings.json', status: 'modified', analysis: 'ignored' }] });
    orchestrator.onSaved(['/repo/.vscode/settings.json']);
    await tick(80);
    await orchestrator.whenIdle();
    expect(executor.calls).toHaveLength(0);
    expect(orchestrator.status.phase).toBe('idle');

    // A comment-only edit reaches no test: "No impacted tests".
    analyzer.auto = () => report([]);
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => orchestrator.status.phase === 'done');
    expect(orchestrator.status.summary?.noTests).toBe(true);
    expect(executor.calls).toHaveLength(0);
  });

  it('reports an error when the analysis fails and no test project is known', async () => {
    const { analyzer, executor, orchestrator } = setup();
    analyzer.testProjects = undefined;
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => analyzer.requests.length === 1);
    analyzer.requests[0].reject(new Error('could not load'));
    await until(() => orchestrator.status.phase === 'error');
    expect(orchestrator.status.message).toContain('could not load');
    expect(executor.calls).toHaveLength(0);
  });
});

/** Coverage participant that answers from queues (DESIGN.md 7.4 integration). */
class FakeCoverage implements CoverageParticipant {
  readonly saved: (readonly string[])[] = [];
  forSaved: ImpactReport | undefined;
  forSavedError: Error | undefined;
  followUps: ImpactReport[] = [];

  async impactForSaved(files: readonly string[]): Promise<ImpactReport | undefined> {
    this.saved.push(files);
    if (this.forSavedError) {
      throw this.forSavedError;
    }
    return this.forSaved;
  }

  takeFollowUp(): (() => Promise<ImpactReport | undefined>) | undefined {
    const next = this.followUps.shift();
    return next ? async () => next : undefined;
  }
}

describe('Orchestrator with coverage', () => {
  it('adds the tests of every new member of the saved file (impactSinceBase) to the save\'s own selection', async () => {
    const coverage = new FakeCoverage();
    coverage.forSaved = report([test('ATests.OldMemberOfTheFile'), test('ATests.LatestEdit')]);
    const { analyzer, executor, orchestrator, logger } = setup(new MemoryStateStore(), coverage);
    analyzer.auto = () => report([test('ATests.LatestEdit')]);
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(coverage.saved).toEqual([['/repo/src/A.cs']]);
    expect(fqns(executor.calls[0])).toEqual(['App.Tests.ATests.LatestEdit', 'App.Tests.ATests.OldMemberOfTheFile']);
    expect(logger.lines.some((l) => l.includes('All new code (coverage) of A.cs: 2 test(s)'))).toBe(true);
  });

  it('a comment-only edit selects nothing by itself, but the file\'s coverage is still recomputed', async () => {
    const coverage = new FakeCoverage();
    coverage.forSaved = report([test('ATests.One')]);
    const { analyzer, executor, orchestrator } = setup(new MemoryStateStore(), coverage);
    analyzer.auto = () => report([], { changedFiles: [] });
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => executor.calls.length === 1);
    expect(fqns(executor.calls[0])).toEqual(['App.Tests.ATests.One']);
  });

  it('a failing coverage analysis is a warning; the save\'s own selection still runs', async () => {
    const coverage = new FakeCoverage();
    coverage.forSavedError = new Error('no merge base');
    const { analyzer, executor, orchestrator, logger } = setup(new MemoryStateStore(), coverage);
    analyzer.auto = () => report([test('ATests.One')]);
    orchestrator.onSaved(['/repo/src/A.cs']);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(fqns(executor.calls[0])).toEqual(['App.Tests.ATests.One']);
    expect(logger.lines.some((l) => l.startsWith('[warn] New-code coverage: analyzing all new code of A.cs failed (no merge base)'))).toBe(true);
    expect(orchestrator.status.phase).toBe('done');
  });

  it('a follow-up runs after the run was applied, so tests that just ran are not dropped from it', async () => {
    const coverage = new FakeCoverage();
    const { analyzer, executor, orchestrator } = setup(new MemoryStateStore(), coverage);
    analyzer.auto = () => report([test('ATests.NewTest')]);
    // The follow-up repeats NewTest (it just ran) together with the file's other test.
    coverage.followUps.push(report([test('ATests.NewTest'), test('ATests.OldTest')]));
    orchestrator.onSaved(['/repo/tests/ATests.cs']);
    await until(() => executor.calls.length === 2);
    await orchestrator.whenIdle();
    expect(fqns(executor.calls[0])).toEqual(['App.Tests.ATests.NewTest']);
    expect(fqns(executor.calls[1])).toEqual(['App.Tests.ATests.NewTest', 'App.Tests.ATests.OldTest']);
    expect(orchestrator.isBusy).toBe(false);
  });

  it('enqueue: Recompute adds its selection and runs it; nothing to add resolves false', async () => {
    const { executor, orchestrator, statuses } = setup();
    expect(await orchestrator.enqueue('Recompute', async () => report([test('ATests.One'), test('BTests.Two')]), { showAnalyzing: true })).toBe(true);
    expect(statuses.some((s) => s.phase === 'analyzing')).toBe(true);
    await until(() => executor.calls.length === 1);
    await orchestrator.whenIdle();
    expect(fqns(executor.calls[0])).toEqual(['App.Tests.ATests.One', 'App.Tests.BTests.Two']);
    expect(await orchestrator.enqueue('Recompute', async () => undefined)).toBe(false);
    expect(await orchestrator.enqueue('Recompute', async () => report([], { changedFiles: [] }))).toBe(false);
    expect(await orchestrator.enqueue('Recompute', async () => {
      throw new Error('boom');
    })).toBe(false);
    await orchestrator.whenIdle();
    expect(executor.calls).toHaveLength(1);
    expect(orchestrator.status.phase).toBe('done');
  });
});
