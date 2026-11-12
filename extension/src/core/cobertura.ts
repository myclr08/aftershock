import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cobertura reports as written by coverlet (`XPlat Code Coverage`, coverlet.MTP) and Microsoft Code
 * Coverage (`Format=cobertura`, `--coverage-output-format cobertura`).
 *
 * A branch point is identified by the method it belongs to. Cobertura only says how many of a line's
 * conditions were covered (`condition-coverage="50% (1/2)"`), not which ones; two reports that each
 * cover one of two conditions can therefore not be told apart from two that cover the same one. Merges
 * across reports take the larger count (never claims coverage that may not exist) and report the case
 * as ambiguous, so the caller can recompute the file in a single run.
 */

export interface BranchPoint {
  /** `Class|Method(signature)`: conditions of different methods on one line are different conditions. */
  key: string;
  covered: number;
  total: number;
}

export interface LineCoverage {
  hits: number;
  branches?: BranchPoint[];
}

/** Line number -> coverage. */
export type FileCoverage = Map<number, LineCoverage>;

export interface CoberturaReport {
  /** `<sources><source>` roots, as written. */
  sources: string[];
  /** `<class filename>` as written -> merged coverage of that file. */
  files: Map<string, FileCoverage>;
}

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null || (value as unknown) === '') {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

const ARRAYS = new Set(['source', 'package', 'class', 'method', 'line', 'condition']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ARRAYS.has(name),
});

/** `"50% (1/2)"` -> { covered: 1, total: 2 }. */
export function parseConditionCoverage(value: unknown): { covered: number; total: number } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /\(\s*(\d+)\s*\/\s*(\d+)\s*\)/.exec(value);
  if (!match) {
    return undefined;
  }
  const covered = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return { covered: Math.min(covered, total), total };
}

function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).trim();
  }
  if (node && typeof node === 'object' && '#text' in (node as XmlNode)) {
    return String((node as XmlNode)['#text']).trim();
  }
  return '';
}

/** Adds one `<line>` to a file, merging with what is there (max hits; branch points by key). */
function addLine(file: FileCoverage, number: number, hits: number, branch: BranchPoint | undefined): void {
  const existing = file.get(number);
  if (!existing) {
    file.set(number, { hits, branches: branch ? [branch] : undefined });
    return;
  }
  existing.hits = Math.max(existing.hits, hits);
  if (branch) {
    const same = existing.branches?.find((b) => b.key === branch.key);
    if (same) {
      // The same method's line listed twice: one set of conditions.
      same.covered = Math.max(same.covered, branch.covered);
      same.total = Math.max(same.total, branch.total);
    } else {
      (existing.branches ??= []).push(branch);
    }
  }
}

function readLine(node: XmlNode): { number: number; hits: number; conditions?: { covered: number; total: number } } | undefined {
  const number = Number(node.number);
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  const hitsValue = Number(node.hits);
  const hits = Number.isFinite(hitsValue) && hitsValue > 0 ? hitsValue : 0;
  const isBranch = String(node.branch ?? '').toLowerCase() === 'true';
  const conditions = isBranch || node['condition-coverage'] !== undefined ? parseConditionCoverage(node['condition-coverage']) : undefined;
  return { number, hits, conditions };
}

export function parseCobertura(xml: string): CoberturaReport {
  const document = parser.parse(xml.replace(/^\uFEFF/, '')) as XmlNode;
  const coverage = document.coverage as XmlNode | undefined;
  if (!coverage || typeof coverage !== 'object') {
    throw new Error('not a Cobertura report (no <coverage> element)');
  }
  const sources = asArray(((coverage.sources ?? {}) as XmlNode).source as unknown[] | undefined)
    .map(text)
    .filter((s) => s.length > 0);
  const files = new Map<string, FileCoverage>();

  for (const pkg of asArray(((coverage.packages ?? {}) as XmlNode).package as XmlNode[] | undefined)) {
    for (const cls of asArray(((pkg.classes ?? {}) as XmlNode).class as XmlNode[] | undefined)) {
      const filename = String(cls.filename ?? '').trim();
      if (!filename) {
        continue;
      }
      const className = String(cls.name ?? '');
      let file = files.get(filename);
      if (!file) {
        file = new Map();
        files.set(filename, file);
      }
      const methodLines = new Set<number>();
      for (const method of asArray(((cls.methods ?? {}) as XmlNode).method as XmlNode[] | undefined)) {
        const key = `${className}|${String(method.name ?? '')}${String(method.signature ?? '')}`;
        for (const lineNode of asArray(((method.lines ?? {}) as XmlNode).line as XmlNode[] | undefined)) {
          const line = readLine(lineNode);
          if (!line) {
            continue;
          }
          methodLines.add(line.number);
          addLine(file, line.number, line.hits, line.conditions ? { key, ...line.conditions } : undefined);
        }
      }
      // Class-level lines repeat the method lines; only lines outside every method are new here.
      for (const lineNode of asArray(((cls.lines ?? {}) as XmlNode).line as XmlNode[] | undefined)) {
        const line = readLine(lineNode);
        if (!line || methodLines.has(line.number)) {
          continue;
        }
        addLine(file, line.number, line.hits, line.conditions ? { key: `${className}|`, ...line.conditions } : undefined);
      }
    }
  }
  return { sources, files };
}

/** Does this look like a Windows path (`C:\x`, `C:/x`, `\\server\share`)? */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function isAbsoluteAnywhere(p: string): boolean {
  return isWindowsPath(p) || p.startsWith('/');
}

function joinIn(root: string, relative: string): string {
  if (isWindowsPath(root)) {
    return path.win32.normalize(path.win32.join(root, relative.replace(/\//g, '\\')));
  }
  return path.posix.normalize(path.posix.join(root.replace(/\\/g, '/'), relative.replace(/\\/g, '/')));
}

export interface ResolveOptions {
  exists?: (file: string) => boolean;
  /** Tried after the report's sources (repository root, solution folder): covers deterministic `/_/` paths. */
  fallbackRoots?: readonly string[];
}

/**
 * Absolute path of a `<class filename>`: absolute names as they are (Microsoft Code Coverage), relative
 * ones against each `<source>` until a file exists (coverlet), then against the fallback roots.
 */
export function resolveCoberturaPath(filename: string, sources: readonly string[], options: ResolveOptions = {}): string {
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  if (isAbsoluteAnywhere(filename) && !filename.startsWith('/_/')) {
    return isWindowsPath(filename) ? path.win32.normalize(filename) : path.posix.normalize(filename);
  }
  const relative = filename.replace(/^\/_\//, '');
  const candidates = [
    ...sources.filter((s) => s !== '/_/' && isAbsoluteAnywhere(s)).map((s) => joinIn(s, relative)),
    ...(options.fallbackRoots ?? []).map((root) => joinIn(root, relative)),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? filename;
}

/** Merges `source` into `target` (another report or run of the same build). Returns the lines whose conditions are ambiguous. */
export function mergeFileCoverage(target: FileCoverage, source: FileCoverage): number[] {
  const ambiguous: number[] = [];
  for (const [number, line] of source) {
    const existing = target.get(number);
    if (!existing) {
      target.set(number, { hits: line.hits, branches: line.branches?.map((b) => ({ ...b })) });
      continue;
    }
    existing.hits = Math.max(existing.hits, line.hits);
    for (const branch of line.branches ?? []) {
      const same = existing.branches?.find((b) => b.key === branch.key);
      if (!same) {
        (existing.branches ??= []).push({ ...branch });
        continue;
      }
      const total = Math.max(same.total, branch.total);
      const low = Math.min(same.covered, branch.covered);
      const high = Math.max(same.covered, branch.covered);
      // Exact when one side covers nothing or everything; otherwise the union lies between `high`
      // and `low + high` and Cobertura cannot say where.
      if (low > 0 && high < total) {
        ambiguous.push(number);
      }
      same.covered = high;
      same.total = total;
    }
  }
  return [...new Set(ambiguous)];
}

export function cloneFileCoverage(file: FileCoverage): FileCoverage {
  return new Map([...file].map(([number, line]) => [number, { hits: line.hits, branches: line.branches?.map((b) => ({ ...b })) }]));
}

/** Conditions of a line: totals over its branch points. */
export function lineConditions(line: LineCoverage): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const branch of line.branches ?? []) {
    covered += branch.covered;
    total += branch.total;
  }
  return { covered, total };
}

/** Cobertura files (`*.xml` with a `<coverage>` root) below a results folder. */
export function findCoberturaFiles(directory: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          visit(full, depth + 1);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml') && looksLikeCobertura(full)) {
        found.push(full);
      }
    }
  };
  visit(directory, 0);
  return found.sort();
}

function looksLikeCobertura(file: string): boolean {
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(2048);
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
      const head = buffer.toString('utf8', 0, read);
      return /<coverage[\s>]/.test(head);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}
