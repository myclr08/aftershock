import * as fs from 'fs';
import * as path from 'path';

export interface SolutionChoice {
  solution?: string;
  /** Every candidate that was considered, in the order of preference. */
  candidates: string[];
  /** Why this solution (or none) was chosen; written to the output channel. */
  message: string;
}

const SOLUTION_EXTENSIONS = ['.sln', '.slnx'];
const SKIPPED_FOLDERS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.vscode', '.idea', 'testresults', 'artifacts']);

function isSolution(name: string): boolean {
  return SOLUTION_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

/** Ordinal, case-insensitive name order; `.sln` before `.slnx` for the same base name. */
export function compareSolutionNames(a: string, b: string): number {
  const baseA = path.basename(a, path.extname(a)).toLowerCase();
  const baseB = path.basename(b, path.extname(b)).toLowerCase();
  if (baseA !== baseB) {
    return baseA < baseB ? -1 : 1;
  }
  const extA = path.extname(a).toLowerCase();
  const extB = path.extname(b).toLowerCase();
  return extA === extB ? 0 : extA === '.sln' ? -1 : 1;
}

function listSolutions(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSolution(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort(compareSolutionNames);
  } catch {
    return [];
  }
}

/** Solutions below the root, breadth first (shallowest first), up to `maxDepth` folders deep. */
function findNested(root: string, maxDepth: number): string[] {
  let level = [root];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const directory of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) {
          next.push(path.join(directory, entry.name));
        }
      }
    }
    next.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    const found = next.flatMap(listSolutions);
    if (found.length > 0) {
      return found;
    }
    level = next;
  }
  return [];
}

/**
 * `aftershock.solution` if set (absolute, or relative to the workspace folder); otherwise the first
 * `.sln`/`.slnx` in the workspace root by name; otherwise the shallowest one below it.
 */
export function discoverSolution(workspaceRoot: string, setting: string | undefined, maxDepth = 3): SolutionChoice {
  const configured = (setting ?? '').trim();
  if (configured) {
    const resolved = path.resolve(workspaceRoot, configured);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return { solution: resolved, candidates: [resolved], message: `Using the solution from aftershock.solution: ${resolved}` };
    }
    return { candidates: [], message: `aftershock.solution points to ${resolved}, which does not exist.` };
  }

  const inRoot = listSolutions(workspaceRoot);
  if (inRoot.length === 1) {
    return { solution: inRoot[0], candidates: inRoot, message: `Using the solution ${inRoot[0]}` };
  }
  if (inRoot.length > 1) {
    return {
      solution: inRoot[0],
      candidates: inRoot,
      message: `Found ${inRoot.length} solutions in the workspace root (${inRoot.map((s) => path.basename(s)).join(', ')}); using ${path.basename(inRoot[0])} (first by name). Set aftershock.solution to choose another.`,
    };
  }

  const nested = findNested(workspaceRoot, maxDepth);
  if (nested.length > 0) {
    const others = nested.length > 1 ? ` (${nested.length} candidates at that depth; first by name). Set aftershock.solution to choose another` : '';
    return {
      solution: nested[0],
      candidates: nested,
      message: `No solution in the workspace root; using ${nested[0]}${others}.`,
    };
  }
  return { candidates: [], message: 'No .sln or .slnx file found in the workspace. Set aftershock.solution.' };
}
