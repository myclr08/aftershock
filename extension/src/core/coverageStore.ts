import * as fs from 'fs';
import * as path from 'path';
import type { FileCoverage } from './cobertura';
import type { CoverageTool } from './coverageCollection';
import { pathKey } from './paths';

/**
 * Coverage per source file (DESIGN.md 7.4), keyed by path and valid only for the exact content it was
 * measured on (`hash`) and the tool that measured it. Persisted as a JSON file in the extension's
 * storage folder.
 */
export interface StoredFile {
  path: string;
  /** SHA-1 of the file content the build compiled. */
  hash: string;
  tool: CoverageTool;
  /**
   * Every test that reaches the file's new members ran in the run this came from (the file's new code
   * was analyzed with impactSinceBase, or every test project ran completely). Later partial runs are
   * merged into it. A file that is only partially measured is shown as "not measured yet".
   */
  complete: boolean;
  /** Every coverable line of the file (not only new ones: the target branch can change). */
  lines: FileCoverage;
  updatedAt: number;
}

/** A file whose complete recomputation was requested and has not run yet. */
export interface AwaitingFile {
  path: string;
  /** Content the selection was computed for. */
  hash: string;
  /** Test projects the selection needs (all must run for the file to be complete). */
  projects: string[];
  reason: 'saved' | 'followUp' | 'recompute';
  requestedAt: number;
}

interface SerializedFile {
  p: string;
  h: string;
  t: CoverageTool;
  c: boolean;
  u: number;
  /** [line, hits] */
  l: [number, number][];
  /** Branch keys of this file. */
  k?: string[];
  /** [line, key index, covered, total] */
  b?: [number, number, number, number][];
}

interface SerializedStore {
  version: 1;
  files: SerializedFile[];
  awaiting: AwaitingFile[];
  testCodeChanged: boolean;
}

const MAX_FILES = 3000;

export class CoverageStore {
  readonly files = new Map<string, StoredFile>();
  readonly awaiting = new Map<string, AwaitingFile>();
  /** A test file was saved since the last completed run (DESIGN.md 7.4, follow-up recomputation). */
  testCodeChanged = false;

  get(file: string): StoredFile | undefined {
    return this.files.get(pathKey(file));
  }

  /** The entry when it was measured on `hash` with `tool`. */
  valid(file: string, hash: string | undefined, tool: CoverageTool): StoredFile | undefined {
    const entry = this.get(file);
    return entry && hash !== undefined && entry.hash === hash && entry.tool === tool ? entry : undefined;
  }

  set(entry: StoredFile): void {
    this.files.set(pathKey(entry.path), entry);
  }

  delete(file: string): boolean {
    return this.files.delete(pathKey(file));
  }

  addAwaiting(entry: AwaitingFile): void {
    this.awaiting.set(pathKey(entry.path), entry);
  }

  toJSON(): SerializedStore {
    const files = [...this.files.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_FILES);
    return {
      version: 1,
      files: files.map((file) => {
        const keys: string[] = [];
        const keyIndex = new Map<string, number>();
        const lines: [number, number][] = [];
        const branches: [number, number, number, number][] = [];
        for (const [number, line] of [...file.lines].sort((a, b) => a[0] - b[0])) {
          lines.push([number, line.hits]);
          for (const branch of line.branches ?? []) {
            let index = keyIndex.get(branch.key);
            if (index === undefined) {
              index = keys.length;
              keys.push(branch.key);
              keyIndex.set(branch.key, index);
            }
            branches.push([number, index, branch.covered, branch.total]);
          }
        }
        return { p: file.path, h: file.hash, t: file.tool, c: file.complete, u: file.updatedAt, l: lines, ...(branches.length ? { k: keys, b: branches } : {}) };
      }),
      awaiting: [...this.awaiting.values()],
      testCodeChanged: this.testCodeChanged,
    };
  }

  static fromJSON(value: unknown): CoverageStore {
    const store = new CoverageStore();
    const data = value as Partial<SerializedStore> | undefined;
    if (!data || data.version !== 1) {
      return store;
    }
    for (const file of data.files ?? []) {
      if (!file || typeof file.p !== 'string' || typeof file.h !== 'string' || !Array.isArray(file.l)) {
        continue;
      }
      const lines: FileCoverage = new Map();
      for (const [number, hits] of file.l) {
        lines.set(number, { hits });
      }
      for (const [number, index, covered, total] of file.b ?? []) {
        const line = lines.get(number) ?? { hits: 0 };
        (line.branches ??= []).push({ key: file.k?.[index] ?? String(index), covered, total });
        lines.set(number, line);
      }
      store.set({ path: file.p, hash: file.h, tool: file.t === 'microsoft' ? 'microsoft' : 'coverlet', complete: !!file.c, lines, updatedAt: Number(file.u) || 0 });
    }
    for (const entry of data.awaiting ?? []) {
      if (entry && typeof entry.path === 'string' && typeof entry.hash === 'string') {
        store.addAwaiting({ ...entry, projects: Array.isArray(entry.projects) ? entry.projects : [] });
      }
    }
    store.testCodeChanged = !!data.testCodeChanged;
    return store;
  }

  static load(file: string): CoverageStore {
    try {
      return CoverageStore.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return new CoverageStore();
    }
  }

  /** Writes the store atomically (temporary file + rename). */
  async save(file: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(this.toJSON()));
    await fs.promises.rename(temporary, file);
  }
}
