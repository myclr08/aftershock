import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findMethodDeclarationLine, locateTest, rangeOnLine, simpleClassName } from '../../src/core/testLocator';
import { tempDir, writeFile } from './helpers';

const source = `using Xunit;

namespace App.Tests;

public class Helpers
{
    public static int Compute() => 1;
}

public class PriceTests
{
    private int Use() => Compute();

    [Fact]
    public void Compute()
    {
        var x = Compute();
        return;
    }

    [Theory]
    [InlineData(1)]
    public async Task Async_Works(int value) { await Task.Delay(value); }
}
`;

describe('test locator', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it('finds a declaration after its class, ignoring calls', () => {
    expect(findMethodDeclarationLine(source, 'App.Tests.PriceTests', 'Compute')).toBe(15);
    expect(findMethodDeclarationLine(source, 'App.Tests.PriceTests', 'Async_Works')).toBe(23);
    expect(findMethodDeclarationLine(source, 'App.Tests.Missing', 'Async_Works')).toBe(23);
    expect(findMethodDeclarationLine(source, 'App.Tests.PriceTests', 'Nope')).toBeUndefined();
  });

  it('computes the method name range', () => {
    expect(rangeOnLine('    public void Compute()', 'Compute')).toEqual({ start: 16, end: 23 });
    expect(rangeOnLine('    [Fact]', 'Other')).toEqual({ start: 4, end: 10 });
  });

  it('simplifies nested and generic class names', () => {
    expect(simpleClassName('Ns.Outer+Inner')).toBe('Inner');
    expect(simpleClassName('Ns.Generic`1')).toBe('Generic');
  });

  it('prefers the known location, then the stack trace file, then the project folder', () => {
    const file = path.join(dir, 'PriceTests.cs');
    writeFile(file, source);
    writeFile(path.join(dir, 'obj', 'Generated.cs'), source);
    expect(locateTest({ className: 'App.Tests.PriceTests', methodName: 'Compute', known: { file, line: 3 } })).toEqual({ file, line: 3 });
    const stack = `   at App.Tests.PriceTests.Compute() in ${file}:line 17`;
    expect(locateTest({ className: 'App.Tests.PriceTests', methodName: 'Compute', stackTrace: stack })).toEqual({ file, line: 15 });
    expect(locateTest({ className: 'App.Tests.PriceTests', methodName: 'Async_Works', projectDirectory: dir })).toEqual({ file, line: 23 });
    expect(locateTest({ className: 'App.Tests.PriceTests', methodName: 'Nope', projectDirectory: dir })).toBeUndefined();
  });
});
