import { describe, expect, it } from 'vitest';
import type { FileCoverage } from '../../src/core/cobertura';
import {
  coveragePercent,
  coverageTenths,
  fileMetrics,
  formatCoverage,
  isBelowThreshold,
  neededForThreshold,
  type CoverageCounts,
} from '../../src/core/coverageMetrics';

const counts = (coverableLines: number, coveredLines: number, conditions: number, coveredConditions: number): CoverageCounts => ({
  coverableLines,
  coveredLines,
  conditions,
  coveredConditions,
});

describe('Sonar new-code coverage formula', () => {
  it('worked example from DESIGN.md 7.3: EL 40, LC 30, 2B 10, CT+CF 6 -> 72%, 7 more for 85%', () => {
    const c = counts(40, 30, 10, 6);
    expect(coveragePercent(c)).toBe(72);
    expect(formatCoverage(c)).toBe('72%');
    // ceil(0.85 * 50) - 36 = 43 - 36
    expect(neededForThreshold(c, 85)).toBe(7);
    expect(isBelowThreshold(c, 85)).toBe(true);
  });

  it('the e2e scenario: a new method with one branch, one path tested -> 6 / 8 = 75%, 1 more', () => {
    // Lines 26, 27, 28, 29, 32, 33 coverable; 32 (the other path) not hit; line 27 has 1 of 2 conditions.
    const c = counts(6, 5, 2, 1);
    expect(coveragePercent(c)).toBe(75);
    // ceil(0.85 * 8) = ceil(6.8) = 7; 7 - 6 = 1
    expect(neededForThreshold(c, 85)).toBe(1);
  });

  it('both paths tested: 100%, nothing needed', () => {
    const c = counts(6, 6, 2, 2);
    expect(coveragePercent(c)).toBe(100);
    expect(formatCoverage(c)).toBe('100%');
    expect(neededForThreshold(c, 85)).toBe(0);
    expect(isBelowThreshold(c, 85)).toBe(false);
  });

  it('no coverable new lines is "n/a", not 0% or 100%, and needs nothing', () => {
    const c = counts(0, 0, 0, 0);
    expect(coveragePercent(c)).toBeUndefined();
    expect(coverageTenths(c)).toBeUndefined();
    expect(formatCoverage(c)).toBe('n/a');
    expect(neededForThreshold(c, 85)).toBe(0);
    expect(isBelowThreshold(c, 85)).toBe(false);
  });

  it('nothing covered: 0%, the whole target is needed', () => {
    const c = counts(10, 0, 4, 0);
    expect(coveragePercent(c)).toBe(0);
    // ceil(0.85 * 14) = ceil(11.9) = 12
    expect(neededForThreshold(c, 85)).toBe(12);
  });

  it('exactly at the target needs nothing (integer arithmetic, no floating-point surprise)', () => {
    // 0.85 * 20 = 17 exactly; 17 covered
    expect(neededForThreshold(counts(20, 17, 0, 0), 85)).toBe(0);
    // 0.7 * 10 is 7.000000000000001 in floating point; must not round up to 8.
    expect(neededForThreshold(counts(10, 7, 0, 0), 70)).toBe(0);
    expect(neededForThreshold(counts(10, 6, 0, 0), 70)).toBe(1);
    // 0.29 * 100 = 28.999999999999996 in floating point.
    expect(neededForThreshold(counts(100, 28, 0, 0), 29)).toBe(1);
    expect(neededForThreshold(counts(100, 29, 0, 0), 29)).toBe(0);
  });

  it('decimal thresholds and the edges 0 and 100', () => {
    // ceil(0.825 * 40) = 33
    expect(neededForThreshold(counts(40, 30, 0, 0), 82.5)).toBe(3);
    expect(neededForThreshold(counts(40, 0, 0, 0), 0)).toBe(0);
    expect(neededForThreshold(counts(40, 39, 0, 0), 100)).toBe(1);
    // Out-of-range values are clamped.
    expect(neededForThreshold(counts(40, 39, 0, 0), 150)).toBe(1);
    expect(neededForThreshold(counts(40, 0, 0, 0), -5)).toBe(0);
  });

  it('displays one decimal, rounded down, so a value below the target never shows as the target', () => {
    // 84.96% -> 84.9%
    const c = counts(2500, 2124, 0, 0);
    expect(coveragePercent(c)).toBeCloseTo(84.96);
    expect(formatCoverage(c)).toBe('84.9%');
    expect(coverageTenths(c)).toBe(849);
    expect(isBelowThreshold(c, 85)).toBe(true);
    // 2/3 -> 66.6%
    expect(formatCoverage(counts(3, 2, 0, 0))).toBe('66.6%');
  });

  it('conditions count like lines in both numerator and denominator', () => {
    // Only conditions uncovered: all 5 lines covered, 1 of 4 conditions -> 6 / 9.
    const c = counts(5, 5, 4, 1);
    expect(formatCoverage(c)).toBe('66.6%');
    // ceil(0.85 * 9) = 8 -> 2 more
    expect(neededForThreshold(c, 85)).toBe(2);
  });
});

describe('fileMetrics', () => {
  const coverage: FileCoverage = new Map([
    [6, { hits: 3 }],
    [7, { hits: 3 }],
    [26, { hits: 1 }],
    [27, { hits: 1, branches: [{ key: 'A|M()', covered: 1, total: 2 }] }],
    [28, { hits: 1 }],
    [29, { hits: 1 }],
    [32, { hits: 0 }],
    [33, { hits: 1 }],
  ]);

  it('counts only new lines that are in the report', () => {
    // Line 24/25/30/31 are new but not coverable (blank, signature, braces without code).
    const metrics = fileMetrics([24, 25, 26, 27, 28, 29, 30, 31, 32, 33], coverage);
    expect(metrics.counts).toEqual({ coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    expect(metrics.uncoveredLines).toEqual([32]);
    expect(metrics.partialLines).toEqual([{ line: 27, hits: 1, covered: 1, total: 2 }]);
    expect(metrics.coveredLines).toEqual([26, 28, 29, 33]);
  });

  it('untracked files: every line is new', () => {
    const metrics = fileMetrics('all', coverage);
    expect(metrics.counts).toEqual({ coverableLines: 8, coveredLines: 7, conditions: 2, coveredConditions: 1 });
  });

  it('no new coverable lines: zero counts', () => {
    expect(fileMetrics([1, 2, 3], coverage).counts).toEqual({ coverableLines: 0, coveredLines: 0, conditions: 0, coveredConditions: 0 });
  });

  it('a line with several methods (branch points) sums their conditions', () => {
    const file: FileCoverage = new Map([
      [
        10,
        {
          hits: 2,
          branches: [
            { key: 'A|Outer()', covered: 2, total: 2 },
            { key: 'A/<>c|<Outer>b__0_0()', covered: 1, total: 2 },
          ],
        },
      ],
    ]);
    const metrics = fileMetrics([10], file);
    expect(metrics.counts).toEqual({ coverableLines: 1, coveredLines: 1, conditions: 4, coveredConditions: 3 });
    expect(metrics.partialLines).toEqual([{ line: 10, hits: 2, covered: 3, total: 4 }]);
  });

  it('a line that ran with no condition covered is uncovered, not partial', () => {
    const file: FileCoverage = new Map([[5, { hits: 0, branches: [{ key: 'k', covered: 0, total: 2 }] }]]);
    const metrics = fileMetrics([5], file);
    expect(metrics.uncoveredLines).toEqual([5]);
    expect(metrics.partialLines).toEqual([]);
    expect(metrics.counts).toEqual({ coverableLines: 1, coveredLines: 0, conditions: 2, coveredConditions: 0 });
  });
});
