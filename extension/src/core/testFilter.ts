// Test selection arguments for `dotnet test` (DESIGN.md 6.2-6.4).

export interface FilterTest {
  fullyQualifiedName: string;
  className: string;
  framework: string;
  parameterized?: boolean;
}

/** Filters longer than this are reduced to class level, then split into batches (DESIGN.md 6.4). */
export const DEFAULT_MAX_FILTER_LENGTH = 8000;

export type SelectionLevel = 'method' | 'class';

/** Characters with a meaning in the VSTest filter syntax; a literal one is escaped with `\`. */
const VSTEST_SPECIAL = /[\\()&|=!~]/g;

export function escapeVsTestFilterValue(value: string): string {
  return value.replace(VSTEST_SPECIAL, (c) => `\\${c}`);
}

/**
 * One VSTest filter term selecting every case of a test method.
 *
 * - xUnit and MSTest report `Ns.Class.Method` for every data row, so `=` selects all rows.
 * - NUnit puts the arguments of parameterized tests into the name (`Ns.Class.Method(1,2)`). The
 *   documented `FullyQualifiedName~Ns.Class.Method\(` crashes NUnit3TestAdapter 5.0 (its filter
 *   converter loops on the escaped parenthesis until it runs out of memory), so a plain prefix-free
 *   "contains" term is used: it matches every case on adapters 3.x-5.x, at the price of also matching
 *   a method whose name merely starts with the same text.
 */
export function vsTestTerm(test: FilterTest): string {
  if (test.framework === 'nunit' && test.parameterized) {
    return `FullyQualifiedName~${escapeVsTestFilterValue(test.fullyQualifiedName)}`;
  }
  return `FullyQualifiedName=${escapeVsTestFilterValue(test.fullyQualifiedName)}`;
}

/** Class-level term: every test of the class (`~Ns.Class.` does not match `Ns.ClassB` or nested classes). */
export function vsTestClassTerm(className: string): string {
  return `FullyQualifiedName~${escapeVsTestFilterValue(className)}.`;
}

/** `(<selection>)&(<user filter>)`; either part may be empty. */
export function combineWithUserFilter(selection: string | undefined, userFilter: string | undefined): string | undefined {
  const user = (userFilter ?? '').trim();
  const sel = (selection ?? '').trim();
  if (!sel) {
    return user || undefined;
  }
  if (!user) {
    return sel;
  }
  return `(${sel})&(${user})`;
}

export interface VsTestFilterPlan {
  level: SelectionLevel;
  /** One complete `--filter` value per `dotnet test` invocation. */
  batches: string[];
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Packs terms into batches whose joined length (plus the user filter) stays within `maxLength`. A term
 * that alone exceeds the limit gets a batch of its own.
 */
export function packIntoBatches<T>(terms: readonly T[], measure: (group: readonly T[]) => number, maxLength: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const term of terms) {
    const candidate = [...current, term];
    if (current.length > 0 && measure(candidate) > maxLength) {
      batches.push(current);
      current = [term];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** VSTest filter(s) for the selected tests of one project: method level, then class level, then batches. */
export function planVsTestFilters(tests: readonly FilterTest[], userFilter: string | undefined, maxLength = DEFAULT_MAX_FILTER_LENGTH): VsTestFilterPlan {
  if (tests.length === 0) {
    throw new Error('no tests to filter');
  }
  const methodTerms = unique(tests.map(vsTestTerm));
  const methodFilter = combineWithUserFilter(methodTerms.join('|'), userFilter)!;
  if (methodFilter.length <= maxLength) {
    return { level: 'method', batches: [methodFilter] };
  }

  const classTerms = unique(tests.map((t) => vsTestClassTerm(t.className)));
  const classFilter = combineWithUserFilter(classTerms.join('|'), userFilter)!;
  if (classFilter.length <= maxLength) {
    return { level: 'class', batches: [classFilter] };
  }

  const groups = packIntoBatches(classTerms, (group) => combineWithUserFilter(group.join('|'), userFilter)!.length, maxLength);
  return { level: 'class', batches: groups.map((group) => combineWithUserFilter(group.join('|'), userFilter)!) };
}

// ---------------------------------------------------------------------------------------------
// xUnit v3 on Microsoft.Testing.Platform: no --filter; --filter-method / --filter-class options.
// ---------------------------------------------------------------------------------------------

export interface ArgsPlan {
  level: SelectionLevel;
  /** Selection arguments per invocation (the common arguments come on top). */
  batches: string[][];
  /** Arguments every invocation gets (for example the translated user filter). */
  common: string[];
  warnings: string[];
}

const XUNIT_NON_TRAIT_PROPERTIES = new Set(['fullyqualifiedname', 'displayname', 'name', 'classname']);

/**
 * Translates the simple VSTest filters people use for traits (`Category=Unit`, `Category!=Integration`,
 * joined with `&`) into xUnit v3 `--filter-trait` / `--filter-not-trait`. xUnit v3 ORs filters of the
 * same kind, so at most one positive trait condition can be expressed; anything else is reported and
 * ignored.
 */
export function translateUserFilterForXunitV3(userFilter: string | undefined): { args: string[]; warning?: string } {
  const filter = (userFilter ?? '').trim();
  if (!filter) {
    return { args: [] };
  }
  const unsupported = { args: [], warning: `aftershock.testFilter "${filter}" cannot be expressed with xUnit v3 (Microsoft.Testing.Platform) options and is ignored for this project; only "Trait=Value" and "Trait!=Value" terms joined with "&" (at most one "=") are translated.` };
  if (/[|()~]/.test(filter)) {
    return unsupported;
  }
  const args: string[] = [];
  let positives = 0;
  for (const term of filter.split('&')) {
    const match = /^\s*([A-Za-z_][\w.]*)\s*(!=|=)\s*(.+?)\s*$/.exec(term);
    if (!match || XUNIT_NON_TRAIT_PROPERTIES.has(match[1].toLowerCase())) {
      return unsupported;
    }
    if (match[2] === '=') {
      positives++;
      args.push('--filter-trait', `${match[1]}=${match[3]}`);
    } else {
      args.push('--filter-not-trait', `${match[1]}=${match[3]}`);
    }
  }
  if (positives > 1) {
    return unsupported;
  }
  return { args };
}

function argsLength(args: readonly string[]): number {
  return args.reduce((sum, arg) => sum + arg.length + 1, 0);
}

/** `--filter-method` per test, else `--filter-class` per class, else batches of class options. */
export function planXunitV3Args(tests: readonly FilterTest[], userFilter: string | undefined, maxLength = DEFAULT_MAX_FILTER_LENGTH): ArgsPlan {
  if (tests.length === 0) {
    throw new Error('no tests to filter');
  }
  const translated = translateUserFilterForXunitV3(userFilter);
  const common = translated.args;
  const warnings = translated.warning ? [translated.warning] : [];
  const budget = maxLength - argsLength(common);

  const methodArgs = unique(tests.map((t) => t.fullyQualifiedName)).flatMap((name) => ['--filter-method', name]);
  if (argsLength(methodArgs) <= budget) {
    return { level: 'method', batches: [methodArgs], common, warnings };
  }

  const classes = unique(tests.map((t) => t.className));
  const classArgs = classes.flatMap((name) => ['--filter-class', name]);
  if (argsLength(classArgs) <= budget) {
    return { level: 'class', batches: [classArgs], common, warnings };
  }

  const groups = packIntoBatches(classes, (group) => argsLength(group.flatMap((name) => ['--filter-class', name])), budget);
  return { level: 'class', batches: groups.map((group) => group.flatMap((name) => ['--filter-class', name])), common, warnings };
}

/**
 * Bridge mode (`TestingPlatformDotnetTestSupport` under VSTest `dotnet test`): the arguments after
 * `--` are joined into one command line for the test application and split again, so a value with
 * spaces or shell-like characters must carry its own double quotes.
 */
export function quoteForBridge(arg: string): string {
  if (arg.length > 0 && !/[\s"|&<>^();]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
