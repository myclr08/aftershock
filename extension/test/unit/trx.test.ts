import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  aggregateByMethod,
  classifyOutcome,
  firstStackLines,
  firstStackLocation,
  methodNameFromStack,
  methodNameFromTrx,
  parseTrx,
  parseTrxDuration,
} from '../../src/core/trx';

// Real TRX files produced from samples/ImpactSample (machine names and paths replaced).
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'trx', name), 'utf8');
const results = (name: string) => aggregateByMethod(parseTrx(fixture(name)).rows);

describe('TRX helpers', () => {
  it('strips argument lists from method names', () => {
    expect(methodNameFromTrx('Cost_ByQuantity(1,13.99d)')).toBe('Cost_ByQuantity');
    expect(methodNameFromTrx('CanRedeem_RespectsThreshold (99,False)')).toBe('CanRedeem_RespectsThreshold');
    expect(methodNameFromTrx('Plain')).toBe('Plain');
  });

  it('parses durations', () => {
    expect(parseTrxDuration('00:00:01.5000000')).toBe(1500);
    expect(parseTrxDuration('1.00:00:00')).toBe(86400000);
    expect(parseTrxDuration(undefined)).toBeUndefined();
  });

  it('classifies outcomes', () => {
    expect(classifyOutcome('Failed')).toBe('failed');
    expect(classifyOutcome('Error')).toBe('failed');
    expect(classifyOutcome('Timeout')).toBe('failed');
    expect(classifyOutcome('NotExecuted')).toBe('skipped');
    expect(classifyOutcome('Passed')).toBe('passed');
  });

  it('finds the method of a custom display name in the stack trace', () => {
    const stack = '   at Ns.Tests.MyTests.Real_Method() in /x/MyTests.cs:line 12\n   at System.Reflection.Foo()';
    expect(methodNameFromStack('Ns.Tests.MyTests', stack)).toBe('Real_Method');
    expect(firstStackLocation(stack, 'Ns.Tests.MyTests')).toEqual({ file: '/x/MyTests.cs', line: 12 });
    expect(firstStackLines(stack, 1)).toEqual(['   at Ns.Tests.MyTests.Real_Method() in /x/MyTests.cs:line 12']);
  });
});

describe('VSTest TRX (dotnet test --logger trx)', () => {
  it('xUnit v2: one failing theory row fails the method, with message and stack', () => {
    const trx = parseTrx(fixture('vstest-xunit-failed.trx'));
    expect(trx.rows).toHaveLength(3);
    const [method] = aggregateByMethod(trx.rows);
    expect(method).toMatchObject({
      fullyQualifiedName: 'Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate',
      className: 'Sample.Tests.XUnit.TaxRatesTests',
      methodName: 'ForCountry_ReturnsRate',
      outcome: 'failed',
      cases: 3,
      failedCases: 1,
    });
    expect(method.failedCase).toContain('"TR"');
    expect(method.message).toContain('Assert.Equal() Failure: Values differ');
    expect(firstStackLocation(method.stackTrace, method.className)).toEqual({ file: '/work/impactsample/tests/Sample.Tests.XUnit/TaxRatesTests.cs', line: 13 });
    expect(trx.counters).toMatchObject({ total: 3, failed: 1, passed: 2 });
  });

  it('xUnit v3 through xunit.runner.visualstudio', () => {
    const methods = results('vstest-xunitv3-failed.trx');
    expect(methods.map((m) => [m.fullyQualifiedName, m.outcome, m.cases])).toEqual([
      ['Sample.Tests.XUnitV3.MoneyV3Tests.Add_IsCommutative', 'passed', 2],
      ['Sample.Tests.XUnitV3.MoneyV3Tests.Add_ReturnsSum', 'failed', 2],
    ]);
    expect(results('vstest-xunitv3-passed.trx').every((m) => m.outcome === 'passed')).toBe(true);
  });

  it('NUnit: arguments in the name are folded into one method', () => {
    const methods = results('vstest-nunit-failed.trx');
    expect(methods.map((m) => [m.fullyQualifiedName, m.outcome, m.cases, m.failedCases])).toEqual([
      ['Sample.Tests.NUnit.ExpressCostCaseTests.Cost_ByQuantity', 'failed', 2, 1],
      ['Sample.Tests.NUnit.ShippingQuoteServiceTests.Quote_Standard', 'passed', 1, 0],
    ]);
    expect(methods[0].failedCase).toBe('Cost_ByQuantity(1,13.99d)');
    expect(methods[0].message).toContain('Expected: 13.99m');
    const passed = results('vstest-nunit-passed.trx');
    expect(passed.find((m) => m.methodName === 'Quote_Express_ByQuantity')?.cases).toBe(2);
  });

  it('MSTest: data rows and a failing plain test', () => {
    const methods = results('vstest-mstest-failed.trx');
    expect(methods.map((m) => [m.fullyQualifiedName, m.outcome, m.cases])).toEqual([
      ['Sample.Tests.MSTest.LoyaltyServiceTests.CanRedeem_RespectsThreshold', 'failed', 2],
      ['Sample.Tests.MSTest.LoyaltyServiceTests.Reset_ClearsPoints', 'failed', 1],
    ]);
    expect(methods[1].message).toContain('Assert.AreEqual failed');
    expect(results('vstest-mstest-passed.trx').every((m) => m.outcome === 'passed')).toBe(true);
  });
});

describe('Microsoft.Testing.Platform TRX', () => {
  it('xUnit v3 --report-xunit-trx', () => {
    const methods = results('mtp-xunitv3-failed.trx');
    expect(methods.map((m) => [m.fullyQualifiedName, m.outcome, m.cases])).toEqual([
      ['Sample.Tests.XUnitV3.MoneyV3Tests.Add_IsCommutative', 'passed', 2],
      ['Sample.Tests.XUnitV3.MoneyV3Tests.Add_ReturnsSum', 'failed', 2],
    ]);
    expect(methods[1].message).toContain('Expected: 4.00 EUR');
  });

  it('NUnit --report-trx (names with arguments)', () => {
    const methods = results('mtp-nunit-failed.trx');
    expect(methods.map((m) => [m.fullyQualifiedName, m.outcome, m.cases])).toEqual([
      ['Sample.Tests.NUnit.ExpressCostCaseTests.Cost_ByQuantity', 'failed', 2],
      ['Sample.Tests.NUnit.ShippingQuoteServiceTests.Quote_Standard', 'passed', 1],
    ]);
  });

  it('MSTest --report-trx (display names with a space before the arguments)', () => {
    const methods = results('mtp-mstest-failed.trx');
    expect(methods.map((m) => [m.fullyQualifiedName, m.outcome, m.cases])).toEqual([
      ['Sample.Tests.MSTest.LoyaltyServiceTests.CanRedeem_RespectsThreshold', 'passed', 2],
      ['Sample.Tests.MSTest.LoyaltyServiceTests.Reset_ClearsPoints', 'failed', 1],
    ]);
  });
});

describe('edge cases', () => {
  it('handles an empty run and MSTest v1 inner results', () => {
    expect(parseTrx('<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results /></TestRun>').rows).toEqual([]);
    const xml = `<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
      <Results>
        <UnitTestResult testId="t1" testName="Data" outcome="Failed" resultType="DataDrivenTest">
          <InnerResults>
            <UnitTestResult testId="t1" testName="Data (Row 1)" outcome="Passed" />
            <UnitTestResult testId="t1" testName="Data (Row 2)" outcome="Failed"><Output><ErrorInfo><Message>row 2 &lt;bad&gt;</Message></ErrorInfo></Output></UnitTestResult>
          </InnerResults>
        </UnitTestResult>
      </Results>
      <TestDefinitions><UnitTest id="t1" name="Data"><TestMethod className="Ns.C" name="Data" /></UnitTest></TestDefinitions>
    </TestRun>`;
    const [method] = aggregateByMethod(parseTrx(xml).rows);
    expect(method).toMatchObject({ fullyQualifiedName: 'Ns.C.Data', outcome: 'failed', cases: 2, failedCases: 1, message: 'row 2 <bad>' });
  });
});
