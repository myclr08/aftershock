import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findCoberturaFiles,
  lineConditions,
  mergeFileCoverage,
  parseCobertura,
  parseConditionCoverage,
  resolveCoberturaPath,
  type FileCoverage,
} from '../../src/core/cobertura';
import { fileMetrics } from '../../src/core/coverageMetrics';
import { pathKey } from '../../src/core/paths';
import { tempDir, writeFile } from './helpers';

// Real reports of samples/ImpactSample with a new DiscountCalculator.ApplyLoyalty method (lines 25-33)
// and one test for its `isMember: true` path, produced on Linux by
//   dotnet test tests/Sample.Tests.XUnit --collect "XPlat Code Coverage;Format=cobertura"   (coverlet.collector 6.0.4)
//   dotnet test tests/Sample.Tests.XUnit --collect "Code Coverage;Format=cobertura"         (Microsoft.CodeCoverage 17.14.1)
//   dotnet test tests/Sample.Tests.NUnit --collect "XPlat Code Coverage;Format=cobertura"    (whole project)
// with the absolute folder replaced by /work/shop/samples/ImpactSample and the timestamp fixed.
// The *-mtp-xunitv3 reports come from a copy with only Sample.Core and Sample.Tests.XUnitV3 (folder
// /work/mini) in Microsoft.Testing.Platform mode (.NET 10 SDK, global.json test runner):
//   --coverage --coverage-output-format cobertura   (Microsoft.Testing.Extensions.CodeCoverage 18.0.4, xunit.v3 3.2.2)
//   --coverlet --coverlet-output-format cobertura   (coverlet.MTP 8.0.1, xunit.v3.mtp-v2 3.2.2; only the
//                                                    Sample.Core package kept: it also instruments the test SDK)
const fixtures = path.join(__dirname, '..', 'fixtures', 'cobertura');
const fixture = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8');
const ROOT = '/work/shop/samples/ImpactSample';
const DISCOUNT = `${ROOT}/src/Sample.Core/Discounts/DiscountCalculator.cs`;
const SHIPPING = `${ROOT}/src/Sample.Core/Shipping/ExpressShipping.cs`;
const LOYALTY_KEY = 'Sample.Core.Discounts.DiscountCalculator|ApplyLoyalty(System.Decimal,System.Boolean)';
/** New lines of the e2e scenario: the blank line before the method and the method itself. */
const NEW_LINES = [24, 25, 26, 27, 28, 29, 30, 31, 32, 33];

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/** Every report file, resolved against its sources (the files "exist" when they are under ROOT). */
function resolved(xml: string): Map<string, FileCoverage> {
  const report = parseCobertura(xml);
  const files = new Map<string, FileCoverage>();
  for (const [name, coverage] of report.files) {
    files.set(resolveCoberturaPath(name, report.sources, { exists: (f) => f.startsWith(ROOT) }), coverage);
  }
  return files;
}

describe('Cobertura parsing (real reports)', () => {
  it('coverlet: relative file names against <source>, one branch point on the if', () => {
    const files = resolved(fixture('coverlet-vstest-xunit.xml'));
    const discount = files.get(DISCOUNT)!;
    expect(discount).toBeDefined();
    expect([...discount.keys()].filter((n) => n >= 24)).toEqual([26, 27, 28, 29, 32, 33]);
    expect(discount.get(27)).toEqual({ hits: 1, branches: [{ key: LOYALTY_KEY, covered: 1, total: 2 }] });
    expect(discount.get(32)).toEqual({ hits: 0, branches: undefined });
    const metrics = fileMetrics(NEW_LINES, discount);
    expect(metrics.counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    expect(metrics.uncoveredLines).toEqual([32]);
    expect(metrics.partialLines.map((p) => p.line)).toEqual([27]);
    // The ApplyCoupon switch: 4 conditions on one line.
    expect(lineConditions(discount.get(17)!)).toEqual({ covered: 0, total: 4 });
    // Test projects are not in coverlet's report.
    expect([...files.keys()].some((f) => f.includes('/tests/'))).toBe(false);
  });

  it('Microsoft Code Coverage: absolute file names, no sources; same numbers for the new method', () => {
    const report = parseCobertura(fixture('microsoft-vstest-xunit.xml'));
    expect(report.sources).toEqual([]);
    const files = resolved(fixture('microsoft-vstest-xunit.xml'));
    const discount = files.get(DISCOUNT)!;
    expect(fileMetrics(NEW_LINES, discount).counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    // It also reports the test assembly (excluded later as a test project).
    expect([...files.keys()].some((f) => f.startsWith(`${ROOT}/tests/`))).toBe(true);
  });

  it('Microsoft Code Coverage: the same line in a class and its lambda class is merged (max hits, conditions once)', () => {
    const shipping = resolved(fixture('microsoft-vstest-xunit.xml')).get(SHIPPING)!;
    // Line 11 appears in ExpressShipping (with the lambda-cache branch) and in ExpressShipping.<>c.
    expect(shipping.get(11)!.hits).toBe(0);
    expect(lineConditions(shipping.get(11)!)).toEqual({ covered: 0, total: 2 });
    expect(shipping.get(11)!.branches).toHaveLength(1);
  });

  it('the tools count branches differently (why aftershock.coverageTool must match the pipeline)', () => {
    const coverlet = resolved(fixture('coverlet-vstest-xunit.xml')).get(SHIPPING)!;
    const microsoft = resolved(fixture('microsoft-vstest-xunit.xml')).get(SHIPPING)!;
    expect(lineConditions(coverlet.get(11)!)).toEqual({ covered: 0, total: 0 });
    expect(lineConditions(microsoft.get(11)!)).toEqual({ covered: 0, total: 2 });
  });

  it('a different <source> root per report (coverlet uses the common folder of the instrumented files)', () => {
    const report = parseCobertura(fixture('coverlet-vstest-nunit.xml'));
    expect(report.sources).toEqual([`${ROOT}/src/Sample.Core/`]);
    expect(report.files.has('Discounts/DiscountCalculator.cs')).toBe(true);
    const files = resolved(fixture('coverlet-vstest-nunit.xml'));
    expect(files.get(SHIPPING)!.get(12)).toEqual({ hits: 5, branches: [{ key: 'Sample.Core.Shipping.ExpressShipping|Cost(Sample.Core.Orders.Order)', covered: 1, total: 2 }] });
  });

  it('merging reports of two test projects: union of hits, conditions exact when one side covers none', () => {
    const xunit = resolved(fixture('coverlet-vstest-xunit.xml'));
    const nunit = resolved(fixture('coverlet-vstest-nunit.xml'));
    const discount = xunit.get(DISCOUNT)!;
    expect(mergeFileCoverage(discount, nunit.get(DISCOUNT)!)).toEqual([]);
    expect(discount.get(27)!.branches).toEqual([{ key: LOYALTY_KEY, covered: 1, total: 2 }]);
    const shipping = xunit.get(SHIPPING)!;
    expect(mergeFileCoverage(shipping, nunit.get(SHIPPING)!)).toEqual([]);
    expect(shipping.get(12)).toEqual({ hits: 5, branches: [{ key: 'Sample.Core.Shipping.ExpressShipping|Cost(Sample.Core.Orders.Order)', covered: 1, total: 2 }] });
  });

  it('two runs that each cover one of two conditions are ambiguous: counted conservatively and reported', () => {
    const a: FileCoverage = new Map([[27, { hits: 1, branches: [{ key: LOYALTY_KEY, covered: 1, total: 2 }] }]]);
    const b: FileCoverage = new Map([
      [27, { hits: 1, branches: [{ key: LOYALTY_KEY, covered: 1, total: 2 }] }],
      [32, { hits: 1 }],
    ]);
    expect(mergeFileCoverage(a, b)).toEqual([27]);
    expect(a.get(27)!.branches).toEqual([{ key: LOYALTY_KEY, covered: 1, total: 2 }]);
    expect(a.get(32)).toEqual({ hits: 1, branches: undefined });
    // Full coverage on one side is exact.
    const c: FileCoverage = new Map([[27, { hits: 2, branches: [{ key: LOYALTY_KEY, covered: 2, total: 2 }] }]]);
    expect(mergeFileCoverage(a, c)).toEqual([]);
    expect(a.get(27)).toEqual({ hits: 2, branches: [{ key: LOYALTY_KEY, covered: 2, total: 2 }] });
  });

  it('conditions of different methods on one line add up', () => {
    const xml = `<?xml version="1.0"?>
<coverage><sources><source>/r/</source></sources><packages><package name="P"><classes>
  <class name="A" filename="a.cs"><methods>
    <method name="Outer" signature="()"><lines><line number="10" hits="3" branch="True" condition-coverage="100% (2/2)"/></lines></method>
  </methods><lines><line number="10" hits="3" branch="True" condition-coverage="100% (2/2)"/><line number="12" hits="0" branch="False"/></lines></class>
  <class name="A/&lt;&gt;c" filename="a.cs"><methods>
    <method name="&lt;Outer&gt;b__0_0" signature="(System.Int32)"><lines><line number="10" hits="7" branch="True" condition-coverage="50% (1/2)"/></lines></method>
  </methods><lines><line number="10" hits="7" branch="True" condition-coverage="50% (1/2)"/></lines></class>
</classes></package></packages></coverage>`;
    const file = parseCobertura(xml).files.get('a.cs')!;
    expect(file.get(10)!.hits).toBe(7);
    expect(file.get(10)!.branches).toEqual([
      { key: 'A|Outer()', covered: 2, total: 2 },
      { key: 'A/<>c|<Outer>b__0_0(System.Int32)', covered: 1, total: 2 },
    ]);
    expect(lineConditions(file.get(10)!)).toEqual({ covered: 3, total: 4 });
    // A class-level line outside every method is kept.
    expect(file.get(12)).toEqual({ hits: 0, branches: undefined });
  });

  it('condition-coverage values', () => {
    expect(parseConditionCoverage('50% (1/2)')).toEqual({ covered: 1, total: 2 });
    expect(parseConditionCoverage('83.33% (5/6)')).toEqual({ covered: 5, total: 6 });
    expect(parseConditionCoverage('100% ( 4 / 4 )')).toEqual({ covered: 4, total: 4 });
    expect(parseConditionCoverage('50%')).toBeUndefined();
    expect(parseConditionCoverage('0% (0/0)')).toBeUndefined();
    expect(parseConditionCoverage(undefined)).toBeUndefined();
  });

  it('Microsoft.Testing.Platform reports (both tools) give the same numbers for the new method', () => {
    const mini = '/work/mini/src/Sample.Core/Discounts/DiscountCalculator.cs';
    const microsoft = parseCobertura(fixture('microsoft-mtp-xunitv3.xml'));
    expect(microsoft.files.has(mini)).toBe(true);
    // coverlet.MTP writes "/" as the source and names relative to it.
    const coverlet = parseCobertura(fixture('coverlet-mtp-xunitv3.xml'));
    expect(coverlet.sources).toEqual(['/']);
    const name = 'work/mini/src/Sample.Core/Discounts/DiscountCalculator.cs';
    expect(resolveCoberturaPath(name, coverlet.sources, { exists: () => true })).toBe(mini);
    for (const discount of [microsoft.files.get(mini)!, coverlet.files.get(name)!]) {
      expect(fileMetrics(NEW_LINES, discount).counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    }
  });

  it('rejects files that are not Cobertura', () => {
    expect(() => parseCobertura('<TestRun/>')).toThrow(/not a Cobertura report/);
  });
});

describe('Cobertura paths on Windows', () => {
  // The coverlet fixture as coverlet writes it on Windows: a drive-letter source and backslashes.
  const windowsCoverlet = fixture('coverlet-vstest-xunit.xml')
    .replace(`<source>${ROOT}/src/</source>`, '<source>C:\\Work\\Shop\\samples\\ImpactSample\\src\\</source>')
    .replace(/filename="([^"]+)"/g, (_, name: string) => `filename="${name.replace(/\//g, '\\')}"`);

  it('joins relative names to a drive-letter source and compares case-insensitively', () => {
    const report = parseCobertura(windowsCoverlet);
    expect(report.files.has('Sample.Core\\Discounts\\DiscountCalculator.cs')).toBe(true);
    const file = resolveCoberturaPath('Sample.Core\\Discounts\\DiscountCalculator.cs', report.sources, { exists: () => true });
    expect(file).toBe('C:\\Work\\Shop\\samples\\ImpactSample\\src\\Sample.Core\\Discounts\\DiscountCalculator.cs');
    expect(pathKey(file, 'win32')).toBe(pathKey('c:\\work\\shop\\SAMPLES\\ImpactSample\\src\\Sample.Core\\Discounts\\DiscountCalculator.cs', 'win32'));
  });

  it('keeps absolute Windows names (Microsoft Code Coverage) and normalizes forward slashes', () => {
    expect(resolveCoberturaPath('C:\\a\\b\\X.cs', [], { exists: () => false })).toBe('C:\\a\\b\\X.cs');
    expect(resolveCoberturaPath('C:/a/b/../b/X.cs', [], { exists: () => false })).toBe('C:\\a\\b\\X.cs');
    expect(resolveCoberturaPath('\\\\server\\share\\src\\X.cs', [], { exists: () => false })).toBe('\\\\server\\share\\src\\X.cs');
  });
});

describe('Cobertura path resolution', () => {
  it('tries every source until the file exists, then the fallback roots (deterministic /_/ paths)', () => {
    const exists = (f: string) => f === '/repo/b/src/X.cs';
    expect(resolveCoberturaPath('src/X.cs', ['/repo/a/', '/repo/b/'], { exists })).toBe('/repo/b/src/X.cs');
    expect(resolveCoberturaPath('/_/src/X.cs', ['/_/'], { exists, fallbackRoots: ['/repo/b'] })).toBe('/repo/b/src/X.cs');
    // Nothing exists: the first candidate.
    expect(resolveCoberturaPath('src/Y.cs', ['/repo/a/'], { exists: () => false })).toBe('/repo/a/src/Y.cs');
  });

  it('finds the reports in a results folder (GUID subfolders) and nothing else', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFile(path.join(dir, 'App.Tests-1', '0f8fad5b-d9cb-469f-a165-70867728950e', 'coverage.cobertura.xml'), fixture('coverlet-vstest-xunit.xml'));
    writeFile(path.join(dir, 'App.Tests-1', 'a1b2', 'user_host_2026-11-12.05_36_20.cobertura.xml'), `\uFEFF${fixture('microsoft-vstest-xunit.xml')}`);
    writeFile(path.join(dir, 'App.Tests-1', 'App.Tests-1.trx'), '<TestRun/>');
    writeFile(path.join(dir, 'App.Tests-1', 'other.xml'), '<settings/>');
    const found = findCoberturaFiles(path.join(dir, 'App.Tests-1')).map((f) => path.basename(f));
    expect(found.sort()).toEqual(['coverage.cobertura.xml', 'user_host_2026-11-12.05_36_20.cobertura.xml']);
    expect(findCoberturaFiles(path.join(dir, 'missing'))).toEqual([]);
  });
});
