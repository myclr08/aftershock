import { describe, expect, it } from 'vitest';
import { parseMtpConsole } from '../../src/core/mtpConsole';

// Shape of `dotnet test` output in Microsoft.Testing.Platform mode (.NET 10 SDK).
const output = `Running tests from /work/tests/App.Tests/bin/Debug/net8.0/App.Tests.dll (net8.0|x64)
failed App.Tests.MoneyTests.Add_ReturnsSum(left: 1, right: 2, expected: 4) (1ms)
  Assert.Equal() Failure: Values differ
  Expected: 4.00 EUR
  Actual:   3.00 EUR
  from /work/tests/App.Tests/bin/Debug/net8.0/App.Tests.dll (net8.0|x64)
failed Reset_ClearsPoints (8ms)
  Assert.AreEqual failed. Expected:<1>. Actual:<0>.

Test run summary: Failed!
  total: 6
  failed: 2
  succeeded: 4
  skipped: 0
  duration: 186ms
`;

describe('parseMtpConsole', () => {
  it('reads failures and the summary', () => {
    const summary = parseMtpConsole(output);
    expect(summary.failures.map((f) => f.name)).toEqual(['App.Tests.MoneyTests.Add_ReturnsSum(left: 1, right: 2, expected: 4)', 'Reset_ClearsPoints']);
    expect(summary.failures[0].message).toBe('Assert.Equal() Failure: Values differ\nExpected: 4.00 EUR\nActual:   3.00 EUR');
    expect(summary).toMatchObject({ total: 6, failed: 2, succeeded: 4, skipped: 0 });
  });
});
