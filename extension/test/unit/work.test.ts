import { describe, expect, it } from 'vitest';
import type { ImpactReport } from '../../src/core/analyzerProtocol';
import { buildPlan, FailedTests, PendingWork } from '../../src/core/work';

const P = '/repo/tests/App.Tests/App.Tests.csproj';
const Q = '/repo/tests/Web.Tests/Web.Tests.csproj';

function report(partial: Partial<ImpactReport>): ImpactReport {
  return { schemaVersion: 1, solution: '', repositoryRoot: '', durationsMs: {}, changedFiles: [], changedSymbols: [], fallback: null, tests: [], testProjects: [], diagnostics: [], ...partial };
}

const t = (fqn: string, project = P, framework = 'xunit') => ({
  fullyQualifiedName: fqn,
  className: fqn.slice(0, fqn.lastIndexOf('.')),
  methodName: fqn.slice(fqn.lastIndexOf('.') + 1),
  framework,
  parameterized: false,
  project,
  projectName: project === P ? 'App.Tests' : 'Web.Tests',
  reason: 'referenceChain',
  chain: ['A', fqn],
});

describe('PendingWork', () => {
  it('merges reports and survives a JSON round trip', () => {
    const work = new PendingWork();
    work.mergeReport(report({ tests: [t('N.A.One')], testProjects: [{ name: 'App.Tests', path: P, mode: 'filter', tests: 1, frameworks: ['xunit'] }] }));
    work.mergeReport(
      report({
        tests: [t('N.A.Two')],
        fallback: { reasons: [{ kind: 'buildFile', file: 'Web.Tests.csproj', message: 'changed', testProjects: [Q] }], testProjects: [Q] },
        testProjects: [{ name: 'Web.Tests', path: Q, mode: 'all', tests: 0, frameworks: ['nunit'] }],
      }),
    );
    const restored = PendingWork.fromJSON(JSON.parse(JSON.stringify(work.toJSON())));
    expect(restored.snapshot()).toEqual(work.snapshot());
    expect(restored.snapshot().map((p) => [p.name, p.all, p.tests.map((x) => x.fullyQualifiedName), p.reasons])).toEqual([
      ['App.Tests', false, ['N.A.One', 'N.A.Two'], []],
      ['Web.Tests', true, [], ['[buildFile] Web.Tests.csproj: changed']],
    ]);
  });

  it('removes only what ran', () => {
    const work = new PendingWork();
    work.mergeReport(report({ tests: [t('N.A.One'), t('N.A.Two')] }));
    work.removeExecuted({ path: P, all: false, tests: [t('N.A.One')] });
    expect(work.snapshot()[0].tests.map((x) => x.fullyQualifiedName)).toEqual(['N.A.Two']);
    work.removeExecuted({ path: P, all: false, tests: [t('N.A.Two')] });
    expect(work.isEmpty).toBe(true);
  });

  it('ignores garbage from storage', () => {
    expect(PendingWork.fromJSON('nonsense').isEmpty).toBe(true);
    expect(PendingWork.fromJSON([null, { name: 'x' }]).isEmpty).toBe(true);
    expect(FailedTests.fromJSON({}).size).toBe(0);
  });
});

describe('buildPlan', () => {
  it('adds previously failed tests to their projects, also projects without a selection', () => {
    const work = new PendingWork();
    work.mergeReport(report({ tests: [t('N.A.One')] }));
    const failed = new FailedTests();
    failed.upsert({ project: P, projectName: 'App.Tests', fullyQualifiedName: 'N.A.One', className: 'N.A', methodName: 'One', framework: 'xunit' });
    failed.upsert({ project: P, projectName: 'App.Tests', fullyQualifiedName: 'N.B.Old', className: 'N.B', methodName: 'Old', framework: 'xunit' });
    failed.upsert({ project: Q, projectName: 'Web.Tests', fullyQualifiedName: 'W.C.Param', className: 'W.C', methodName: 'Param', framework: 'nunit', parameterized: true });
    const plans = buildPlan(work.snapshot(), failed.all());
    expect(plans.map((p) => [p.name, p.mode, p.frameworks, p.tests.map((x) => [x.fullyQualifiedName, x.origin, x.parameterized])])).toEqual([
      ['App.Tests', 'filter', ['xunit'], [['N.A.One', 'selected', false], ['N.B.Old', 'previouslyFailed', false]]],
      ['Web.Tests', 'filter', ['nunit'], [['W.C.Param', 'previouslyFailed', true]]],
    ]);
  });

  it('is empty without work and failures, and skips projects with nothing to run', () => {
    expect(buildPlan([], [])).toEqual([]);
    expect(buildPlan([{ path: P, name: 'App.Tests', frameworks: ['xunit'], all: false, reasons: [], tests: [] }], [])).toEqual([]);
  });
});
