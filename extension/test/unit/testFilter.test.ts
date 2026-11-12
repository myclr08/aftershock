import { describe, expect, it } from 'vitest';
import {
  combineWithUserFilter,
  escapeVsTestFilterValue,
  packIntoBatches,
  planVsTestFilters,
  planXunitV3Args,
  quoteForBridge,
  translateUserFilterForXunitV3,
  vsTestClassTerm,
  vsTestTerm,
  type FilterTest,
} from '../../src/core/testFilter';

const xunit = (fqn: string): FilterTest => ({ fullyQualifiedName: fqn, className: fqn.slice(0, fqn.lastIndexOf('.')), framework: 'xunit', parameterized: false });

describe('VSTest filter terms', () => {
  it('escapes every special character of the filter syntax', () => {
    expect(escapeVsTestFilterValue('A(b)&c|d=e!f~g\\h')).toBe('A\\(b\\)\\&c\\|d\\=e\\!f\\~g\\\\h');
    expect(escapeVsTestFilterValue('Ns.Outer+Inner.Method')).toBe('Ns.Outer+Inner.Method');
  });

  it('selects xUnit and MSTest methods exactly (data rows share the name)', () => {
    expect(vsTestTerm(xunit('Ns.C.M'))).toBe('FullyQualifiedName=Ns.C.M');
    expect(vsTestTerm({ fullyQualifiedName: 'Ns.C.Rows', className: 'Ns.C', framework: 'mstest', parameterized: true })).toBe('FullyQualifiedName=Ns.C.Rows');
    expect(vsTestTerm({ fullyQualifiedName: 'Ns.C.Theory', className: 'Ns.C', framework: 'xunit', parameterized: true })).toBe('FullyQualifiedName=Ns.C.Theory');
  });

  it('selects parameterized NUnit tests with a contains term and never with an escaped parenthesis', () => {
    // NUnit puts arguments into the name; NUnit3TestAdapter 5.0 crashes on "\(".
    const term = vsTestTerm({ fullyQualifiedName: 'Ns.C.Cost_ByQuantity', className: 'Ns.C', framework: 'nunit', parameterized: true });
    expect(term).toBe('FullyQualifiedName~Ns.C.Cost_ByQuantity');
    expect(term).not.toContain('(');
    expect(vsTestTerm({ fullyQualifiedName: 'Ns.C.Plain', className: 'Ns.C', framework: 'nunit', parameterized: false })).toBe('FullyQualifiedName=Ns.C.Plain');
  });

  it('builds class terms with a trailing dot', () => {
    expect(vsTestClassTerm('Ns.Outer+Inner')).toBe('FullyQualifiedName~Ns.Outer+Inner.');
  });

  it('combines the selection with the user filter', () => {
    expect(combineWithUserFilter('A|B', 'Category!=Integration')).toBe('(A|B)&(Category!=Integration)');
    expect(combineWithUserFilter('A', '  ')).toBe('A');
    expect(combineWithUserFilter(undefined, 'Category=Unit')).toBe('Category=Unit');
    expect(combineWithUserFilter('', '')).toBeUndefined();
  });
});

describe('planVsTestFilters', () => {
  it('joins exact terms with | and de-duplicates them', () => {
    const plan = planVsTestFilters([xunit('Ns.B.Two'), xunit('Ns.A.One'), xunit('Ns.A.One')], undefined);
    expect(plan).toEqual({ level: 'method', batches: ['FullyQualifiedName=Ns.A.One|FullyQualifiedName=Ns.B.Two'] });
  });

  it('adds the user filter as (<selection>)&(<user>)', () => {
    const plan = planVsTestFilters([xunit('Ns.A.One')], 'Category!=Integration');
    expect(plan.batches).toEqual(['(FullyQualifiedName=Ns.A.One)&(Category!=Integration)']);
  });

  it('falls back to class level when the method filter is too long', () => {
    const tests = Array.from({ length: 300 }, (_, i) => xunit(`Company.Product.Tests.Area${i % 3}.SomeTests.Method_With_A_Long_Name_${i}`));
    const plan = planVsTestFilters(tests, undefined, 8000);
    expect(plan.level).toBe('class');
    expect(plan.batches).toEqual(['FullyQualifiedName~Company.Product.Tests.Area0.SomeTests.|FullyQualifiedName~Company.Product.Tests.Area1.SomeTests.|FullyQualifiedName~Company.Product.Tests.Area2.SomeTests.']);
  });

  it('splits class terms into batches when even the class filter is too long', () => {
    const tests = Array.from({ length: 500 }, (_, i) => xunit(`Company.Product.Tests.Feature${i}Tests.Method`));
    const user = 'Category!=Integration';
    const plan = planVsTestFilters(tests, user, 8000);
    expect(plan.level).toBe('class');
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const batch of plan.batches) {
      expect(batch.length).toBeLessThanOrEqual(8000);
      expect(batch.endsWith(`)&(${user})`)).toBe(true);
    }
    const classes = plan.batches.flatMap((b) => b.slice(1, b.indexOf(')&(')).split('|'));
    expect(new Set(classes).size).toBe(500);
  });

  it('respects a custom limit', () => {
    const plan = planVsTestFilters([xunit('Ns.A.One'), xunit('Ns.B.Two')], undefined, 30);
    expect(plan.level).toBe('class');
    expect(plan.batches).toEqual(['FullyQualifiedName~Ns.A.', 'FullyQualifiedName~Ns.B.']);
  });
});

describe('packIntoBatches', () => {
  it('keeps every group within the limit and puts an oversized term alone', () => {
    const groups = packIntoBatches(['aaaa', 'bb', 'cc', 'dddddddddd', 'e'], (g) => g.join('|').length, 6);
    expect(groups).toEqual([['aaaa'], ['bb', 'cc'], ['dddddddddd'], ['e']]);
  });
});

describe('xUnit v3 on Microsoft.Testing.Platform', () => {
  it('uses --filter-method per test', () => {
    const plan = planXunitV3Args([xunit('Ns.B.Two'), xunit('Ns.A.One')], undefined);
    expect(plan.level).toBe('method');
    expect(plan.batches).toEqual([['--filter-method', 'Ns.A.One', '--filter-method', 'Ns.B.Two']]);
    expect(plan.common).toEqual([]);
  });

  it('reduces to --filter-class and then batches', () => {
    const tests = Array.from({ length: 400 }, (_, i) => xunit(`Company.Product.Tests.Feature${i}Tests.Method_${i}`));
    const plan = planXunitV3Args(tests, undefined, 8000);
    expect(plan.level).toBe('class');
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const batch of plan.batches) {
      expect(batch.reduce((n, a) => n + a.length + 1, 0)).toBeLessThanOrEqual(8000);
      expect(batch.filter((a) => a === '--filter-class').length * 2).toBe(batch.length);
    }
  });

  it('translates simple trait filters', () => {
    expect(translateUserFilterForXunitV3('Category!=Integration')).toEqual({ args: ['--filter-not-trait', 'Category=Integration'] });
    expect(translateUserFilterForXunitV3('Category=Unit&Speed!=Slow')).toEqual({ args: ['--filter-trait', 'Category=Unit', '--filter-not-trait', 'Speed=Slow'] });
    expect(translateUserFilterForXunitV3('')).toEqual({ args: [] });
  });

  it('reports filters it cannot express', () => {
    expect(translateUserFilterForXunitV3('Category=A|Category=B').warning).toBeDefined();
    expect(translateUserFilterForXunitV3('FullyQualifiedName~Slow').warning).toBeDefined();
    expect(translateUserFilterForXunitV3('Category=A&Owner=B').warning).toBeDefined();
    const plan = planXunitV3Args([xunit('Ns.A.One')], 'Category=A|Category=B');
    expect(plan.common).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
  });
});

describe('quoteForBridge', () => {
  it('leaves plain arguments alone', () => {
    expect(quoteForBridge('--filter-method')).toBe('--filter-method');
    expect(quoteForBridge('Ns.Class.Method')).toBe('Ns.Class.Method');
  });

  it('quotes values with spaces or command line metacharacters', () => {
    expect(quoteForBridge('C:\\Users\\John Doe\\results')).toBe('"C:\\Users\\John Doe\\results"');
    expect(quoteForBridge('FullyQualifiedName=A|FullyQualifiedName=B')).toBe('"FullyQualifiedName=A|FullyQualifiedName=B"');
    expect(quoteForBridge('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteForBridge('dir with space\\')).toBe('"dir with space\\\\"');
  });
});
