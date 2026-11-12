import { lineConditions, type FileCoverage } from './cobertura';
import { isNewLine, type NewLines } from './newCode';

/**
 * Sonar's coverage formula on new lines only (DESIGN.md 7.3):
 *
 *     Coverage = (CT + CF + LC) / (2*B + EL)
 *
 * EL = coverable new lines (new lines that appear in the Cobertura report), LC = those with hits > 0,
 * 2*B = conditions on new lines, CT + CF = covered conditions. All arithmetic is on integers.
 */
export interface CoverageCounts {
  /** EL */
  coverableLines: number;
  /** LC */
  coveredLines: number;
  /** 2*B */
  conditions: number;
  /** CT + CF */
  coveredConditions: number;
}

export const ZERO_COUNTS: Readonly<CoverageCounts> = Object.freeze({ coverableLines: 0, coveredLines: 0, conditions: 0, coveredConditions: 0 });

export function addCounts(a: CoverageCounts, b: CoverageCounts): CoverageCounts {
  return {
    coverableLines: a.coverableLines + b.coverableLines,
    coveredLines: a.coveredLines + b.coveredLines,
    conditions: a.conditions + b.conditions,
    coveredConditions: a.coveredConditions + b.coveredConditions,
  };
}

/** 2*B + EL */
export function coverageDenominator(c: CoverageCounts): number {
  return c.conditions + c.coverableLines;
}

/** CT + CF + LC */
export function coverageNumerator(c: CoverageCounts): number {
  return c.coveredConditions + c.coveredLines;
}

/** Coverage in percent, or undefined ("n/a") when there is nothing coverable on new lines. */
export function coveragePercent(c: CoverageCounts): number | undefined {
  const denominator = coverageDenominator(c);
  return denominator === 0 ? undefined : (100 * coverageNumerator(c)) / denominator;
}

/** Coverage in tenths of a percent, rounded down (so a value below the target never displays as the target). */
export function coverageTenths(c: CoverageCounts): number | undefined {
  const denominator = coverageDenominator(c);
  if (denominator === 0) {
    return undefined;
  }
  return Number((BigInt(coverageNumerator(c)) * 1000n) / BigInt(denominator));
}

/** "87%", "84.9%", "n/a" (one decimal, rounded down). */
export function formatCoverage(c: CoverageCounts): string {
  const tenths = coverageTenths(c);
  return tenths === undefined ? 'n/a' : `${formatTenths(tenths)}%`;
}

export function formatTenths(tenths: number): string {
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

/** A percentage such as 85 or 82.5 as an exact fraction numerator/denominator. */
function percentAsFraction(percent: number): { numerator: bigint; denominator: bigint } {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  // Up to six decimals are honoured; the string form avoids binary floating-point noise.
  const [whole, fraction = ''] = clamped.toFixed(6).replace(/0+$/, '').replace(/\.$/, '').split('.');
  const scale = 10n ** BigInt(fraction.length);
  return { numerator: BigInt(whole) * scale + BigInt(fraction || '0'), denominator: 100n * scale };
}

/**
 * How many more lines or conditions must be covered to reach `thresholdPercent`:
 * `ceil(t * (2*B + EL)) - (CT + CF + LC)`, never negative.
 */
export function neededForThreshold(c: CoverageCounts, thresholdPercent: number): number {
  const total = BigInt(coverageDenominator(c));
  if (total === 0n) {
    return 0;
  }
  const { numerator, denominator } = percentAsFraction(thresholdPercent);
  const product = numerator * total;
  const required = (product + denominator - 1n) / denominator;
  const missing = required - BigInt(coverageNumerator(c));
  return missing > 0n ? Number(missing) : 0;
}

/** Whether the coverage is below the threshold (false for "n/a"). */
export function isBelowThreshold(c: CoverageCounts, thresholdPercent: number): boolean {
  return neededForThreshold(c, thresholdPercent) > 0;
}

export interface PartialLine {
  line: number;
  hits: number;
  covered: number;
  total: number;
}

export interface FileMetrics {
  counts: CoverageCounts;
  /** New coverable lines with no hits. */
  uncoveredLines: number[];
  /** New lines that ran but miss some conditions. */
  partialLines: PartialLine[];
  /** New lines with hits and every condition covered. */
  coveredLines: number[];
}

/** The new-code counts of one file. Lines that are not in the report are not coverable. */
export function fileMetrics(newLines: NewLines, coverage: FileCoverage): FileMetrics {
  const counts: CoverageCounts = { ...ZERO_COUNTS };
  const uncoveredLines: number[] = [];
  const partialLines: PartialLine[] = [];
  const coveredLines: number[] = [];
  const numbers = [...coverage.keys()].sort((a, b) => a - b);
  for (const number of numbers) {
    if (!isNewLine(newLines, number)) {
      continue;
    }
    const line = coverage.get(number)!;
    const conditions = lineConditions(line);
    counts.coverableLines++;
    counts.conditions += conditions.total;
    counts.coveredConditions += conditions.covered;
    if (line.hits > 0) {
      counts.coveredLines++;
    }
    if (line.hits <= 0) {
      uncoveredLines.push(number);
    } else if (conditions.covered < conditions.total) {
      partialLines.push({ line: number, hits: line.hits, covered: conditions.covered, total: conditions.total });
    } else {
      coveredLines.push(number);
    }
  }
  return { counts, uncoveredLines, partialLines, coveredLines };
}
