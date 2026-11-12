import { XMLParser } from 'fast-xml-parser';

/** One result row of a TRX file (one test case: a theory row, a data row, a plain test). */
export interface TrxRow {
  className: string;
  /** `TestMethod/@name` as written: NUnit and MTP-produced files append the arguments. */
  rawName: string;
  /** The method name with any argument list removed. */
  methodName: string;
  /** `UnitTestResult/@testName` (display name). */
  displayName: string;
  outcome: string;
  message?: string;
  stackTrace?: string;
  durationMs?: number;
}

export interface TrxFile {
  rows: TrxRow[];
  /** `ResultSummary/@outcome` (Completed, Failed, ...). */
  runOutcome?: string;
  counters?: Record<string, number>;
  /** Run-level error output (adapter crashes, "No test matches"). */
  runMessages: string[];
}

export type MethodOutcome = 'passed' | 'failed' | 'skipped';

/** All cases of one test method, merged. */
export interface TestMethodResult {
  className: string;
  methodName: string;
  /** `Ns.Class.Method` (no arguments): the key the analyzer reports. */
  fullyQualifiedName: string;
  outcome: MethodOutcome;
  cases: number;
  failedCases: number;
  /** Display name of the first failing case. */
  failedCase?: string;
  message?: string;
  stackTrace?: string;
  durationMs: number;
}

const FAILED_OUTCOMES = new Set(['failed', 'error', 'timeout', 'aborted']);
const SKIPPED_OUTCOMES = new Set(['notexecuted', 'inconclusive', 'notrunnable', 'disconnected', 'pending', 'skipped']);

export function classifyOutcome(outcome: string): MethodOutcome {
  const value = outcome.toLowerCase();
  if (FAILED_OUTCOMES.has(value)) {
    return 'failed';
  }
  if (SKIPPED_OUTCOMES.has(value)) {
    return 'skipped';
  }
  return 'passed';
}

/** `Method(1,2)` / `Method (1,True)` / `Method<Int32>(x)` -> `Method`. */
export function methodNameFromTrx(rawName: string): string {
  const paren = rawName.indexOf('(');
  return (paren >= 0 ? rawName.slice(0, paren) : rawName).trim();
}

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_`]*$/u;

/**
 * When a TRX name is a custom display name (MSTest `[TestMethod("...")]` under Microsoft.Testing.Platform),
 * the first stack frame of the test's class still names the method.
 */
export function methodNameFromStack(className: string, stackTrace: string | undefined): string | undefined {
  if (!stackTrace) {
    return undefined;
  }
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`at ${escaped}\\.([\\p{L}_][\\p{L}\\p{N}_\`]*)[<(]`, 'u').exec(stackTrace);
  return match?.[1];
}

/** "00:00:01.2345678" -> ms. */
export function parseTrxDuration(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours)) * 60 + Number(minutes)) * 60000 + Number(seconds) * 1000;
}

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function text(node: unknown): string | undefined {
  if (node === undefined || node === null) {
    return undefined;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (typeof node === 'object' && '#text' in (node as XmlNode)) {
    return String((node as XmlNode)['#text']);
  }
  return undefined;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name) => name === 'UnitTestResult' || name === 'UnitTest',
});

/** Parses a TRX file (VSTest logger, MTP `--report-trx`, xUnit v3 `--report-xunit-trx`). */
export function parseTrx(xml: string): TrxFile {
  const document = parser.parse(xml.replace(/^\uFEFF/, '')) as XmlNode;
  const run = (document.TestRun ?? {}) as XmlNode;

  // testId -> (className, method name) from the definitions.
  const definitions = new Map<string, { className: string; rawName: string }>();
  const testDefinitions = (run.TestDefinitions ?? {}) as XmlNode;
  for (const unitTest of asArray(testDefinitions.UnitTest as XmlNode[] | undefined)) {
    const method = (unitTest.TestMethod ?? {}) as XmlNode;
    definitions.set(String(unitTest.id ?? ''), {
      className: String(method.className ?? ''),
      rawName: String(method.name ?? unitTest.name ?? ''),
    });
  }

  const rows: TrxRow[] = [];
  const collect = (result: XmlNode): void => {
    const inner = asArray(((result.InnerResults ?? {}) as XmlNode).UnitTestResult as XmlNode[] | undefined);
    if (inner.length > 0) {
      // Old MSTest data-driven parent: its rows carry the outcomes.
      inner.forEach(collect);
      return;
    }
    const definition = definitions.get(String(result.testId ?? ''));
    const displayName = String(result.testName ?? '');
    const errorInfo = (((result.Output ?? {}) as XmlNode).ErrorInfo ?? {}) as XmlNode;
    const message = text(errorInfo.Message)?.trim();
    const stackTrace = text(errorInfo.StackTrace)?.replace(/\s+$/, '');
    let className = definition?.className ?? '';
    let rawName = definition?.rawName ?? displayName;
    if (!className && displayName.includes('.')) {
      const plain = methodNameFromTrx(displayName);
      className = plain.slice(0, plain.lastIndexOf('.'));
      rawName = displayName.slice(className.length + 1);
    }
    let methodName = methodNameFromTrx(rawName);
    if (!IDENTIFIER.test(methodName)) {
      methodName = methodNameFromStack(className, stackTrace) ?? methodName;
    }
    rows.push({
      className,
      rawName,
      methodName,
      displayName,
      outcome: String(result.outcome ?? 'Unknown'),
      message: message || undefined,
      stackTrace: stackTrace || undefined,
      durationMs: parseTrxDuration(result.duration as string | undefined),
    });
  };
  for (const result of asArray(((run.Results ?? {}) as XmlNode).UnitTestResult as XmlNode[] | undefined)) {
    collect(result);
  }

  const summary = (run.ResultSummary ?? {}) as XmlNode;
  const countersNode = (summary.Counters ?? {}) as XmlNode;
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(countersNode)) {
    const n = Number(value);
    if (!Number.isNaN(n)) {
      counters[key] = n;
    }
  }
  const runMessages: string[] = [];
  const runInfos = ((summary.RunInfos ?? {}) as XmlNode).RunInfo;
  for (const info of asArray(runInfos as XmlNode | XmlNode[] | undefined)) {
    const value = text((info as XmlNode).Text);
    if (value?.trim()) {
      runMessages.push(value.trim());
    }
  }
  const errorText = text((((summary.Output ?? {}) as XmlNode).StdErr) as unknown);
  if (errorText?.trim()) {
    runMessages.push(errorText.trim());
  }

  return {
    rows,
    runOutcome: summary.outcome as string | undefined,
    counters: Object.keys(counters).length > 0 ? counters : undefined,
    runMessages,
  };
}

/** Merges the cases of each method: failed if any case failed, skipped if all were skipped. */
export function aggregateByMethod(rows: readonly TrxRow[]): TestMethodResult[] {
  const byMethod = new Map<string, TestMethodResult>();
  for (const row of rows) {
    const fullyQualifiedName = row.className ? `${row.className}.${row.methodName}` : row.methodName;
    let entry = byMethod.get(fullyQualifiedName);
    if (!entry) {
      entry = {
        className: row.className,
        methodName: row.methodName,
        fullyQualifiedName,
        outcome: 'skipped',
        cases: 0,
        failedCases: 0,
        durationMs: 0,
      };
      byMethod.set(fullyQualifiedName, entry);
    }
    entry.cases++;
    entry.durationMs += row.durationMs ?? 0;
    const outcome = classifyOutcome(row.outcome);
    if (outcome === 'failed') {
      entry.failedCases++;
      if (entry.outcome !== 'failed') {
        entry.outcome = 'failed';
        entry.failedCase = row.displayName;
        entry.message = row.message;
        entry.stackTrace = row.stackTrace;
      }
    } else if (outcome === 'passed' && entry.outcome === 'skipped') {
      entry.outcome = 'passed';
    }
  }
  return [...byMethod.values()].sort((a, b) => a.fullyQualifiedName.localeCompare(b.fullyQualifiedName));
}

/** The first `count` non-empty lines of a stack trace. */
export function firstStackLines(stackTrace: string | undefined, count: number): string[] {
  if (!stackTrace) {
    return [];
  }
  return stackTrace
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, count);
}

/** `at Ns.Class.Method(...) in /path/File.cs:line 12` -> file and line of the first frame with a location. */
export function firstStackLocation(stackTrace: string | undefined, className?: string): { file: string; line: number } | undefined {
  if (!stackTrace) {
    return undefined;
  }
  const frames = stackTrace.split(/\r?\n/);
  const pattern = /\bin (.+):line (\d+)\s*$/;
  const preferred = className ? frames.filter((frame) => frame.includes(`${className}.`)) : [];
  for (const frame of [...preferred, ...frames]) {
    const match = pattern.exec(frame.trim());
    if (match) {
      return { file: match[1], line: Number(match[2]) };
    }
  }
  return undefined;
}
