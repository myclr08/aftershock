import { spawn } from 'child_process';
import * as path from 'path';
import { pathKey } from './paths';

/**
 * "New code" (DESIGN.md 7.1): the lines added or changed in the working tree relative to the merge base
 * of HEAD and the target branch, plus every line of untracked files.
 */

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

/** Runs git without a shell; never prompts, never takes optional locks (the user's own git commands win). */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const finish = (result: GitResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      const child = spawn('git', [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
      child.stdout.on('data', (data: Buffer) => chunks.push(data));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => {
        stderr += data;
      });
      child.once('error', (error) => finish({ code: null, stdout: Buffer.alloc(0), stderr: error.message }));
      child.once('close', (code) => finish({ code, stdout: Buffer.concat(chunks), stderr }));
    } catch (error) {
      finish({ code: null, stdout: Buffer.alloc(0), stderr: (error as Error).message });
    }
  });

async function gitText(run: GitRunner, args: readonly string[], cwd: string): Promise<string | undefined> {
  const result = await run(args, cwd);
  return result.code === 0 ? result.stdout.toString('utf8').trim() : undefined;
}

/**
 * The repository root as seen from `directory` (`--show-cdup`, not `--show-toplevel`): the latter
 * resolves symbolic links, while VS Code, MSBuild and the compiler keep the path the folder was
 * opened with.
 */
export async function repositoryRoot(directory: string, run: GitRunner = runGit): Promise<string | undefined> {
  const cdup = await gitText(run, ['rev-parse', '--show-cdup'], directory);
  if (cdup === undefined) {
    return undefined;
  }
  return path.resolve(directory, cdup || '.');
}

/** Automatic target branches, in this order (DESIGN.md 7.1). */
export const AUTO_TARGETS = ['origin/HEAD', 'origin/main', 'origin/master', 'origin/develop'];

export interface TargetResolution {
  /** The ref that was chosen (as given in the setting, or the automatic candidate). */
  ref?: string;
  /** Where it came from. */
  source?: 'setting' | 'auto';
  /** Why no target could be found. */
  error?: string;
}

async function resolvesToCommit(run: GitRunner, repo: string, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith('-')) {
    return false;
  }
  const result = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], repo);
  return result.code === 0;
}

export async function resolveTarget(repo: string, setting: string, run: GitRunner = runGit): Promise<TargetResolution> {
  const configured = setting.trim();
  if (configured) {
    if (await resolvesToCommit(run, repo, configured)) {
      return { ref: configured, source: 'setting' };
    }
    return { error: `aftershock.targetBranch "${configured}" does not resolve to a commit (fetch it, or fix the setting)` };
  }
  for (const candidate of AUTO_TARGETS) {
    if (await resolvesToCommit(run, repo, candidate)) {
      return { ref: candidate, source: 'auto' };
    }
  }
  return { error: `none of ${AUTO_TARGETS.join(', ')} exists; set aftershock.targetBranch to the branch your pull requests target` };
}

export async function mergeBase(repo: string, target: string, run: GitRunner = runGit): Promise<string | undefined> {
  return gitText(run, ['merge-base', 'HEAD', '--end-of-options', target], repo);
}

export async function headCommit(repo: string, run: GitRunner = runGit): Promise<string | undefined> {
  return gitText(run, ['rev-parse', '--verify', '--quiet', 'HEAD'], repo);
}

/** The new lines of one file: line numbers (1-based, ascending), or every line (untracked files). */
export type NewLines = number[] | 'all';

/** C-style quoted path of git (`"a\tb\303\244.cs"`) -> the path (octal escapes are UTF-8 bytes). */
export function unquoteGitPath(quoted: string): string {
  if (!quoted.startsWith('"')) {
    return quoted;
  }
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < quoted.length; i++) {
    const c = quoted[i];
    if (c === '"') {
      break;
    }
    if (c === '\\') {
      const next = quoted[i + 1];
      if (/[0-7]/.test(next)) {
        const octal = quoted.slice(i + 1, i + 4);
        bytes.push(parseInt(octal, 8));
        i += 3;
        continue;
      }
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i++;
      continue;
    }
    bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path of a `+++ b/<path>` line (undefined for /dev/null). */
function newPathOf(header: string): string | undefined {
  let value = header.slice(4);
  if (value === '/dev/null') {
    return undefined;
  }
  if (value.startsWith('"')) {
    value = unquoteGitPath(value);
  } else if (value.endsWith('\t')) {
    // git appends a tab when the name contains a space, so that `patch` can tell where it ends.
    value = value.slice(0, -1);
  }
  return value.startsWith('b/') ? value.slice(2) : value;
}

/**
 * Parses `git diff -U0` output into the new line numbers per (repository-relative) path. Hunks are
 * consumed by their line counts, so a content line that looks like a header (`+++ x` as an added
 * line `++ x`) is never taken for one. Deleted files, pure deletions, binary files, mode changes and
 * pure renames contribute no lines.
 */
export function parseDiffU0(output: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  const lines = output.split('\n');
  let current: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      current = undefined;
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = newPathOf(line);
      i++;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
      const start = Number(hunk[2]);
      const added = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (current !== undefined && added > 0) {
        const list = result.get(current) ?? [];
        for (let n = 0; n < added; n++) {
          list.push(start + n);
        }
        result.set(current, list);
      }
      // Skip the hunk body: `removed` lines starting with '-', `added` lines with '+', and
      // "\ No newline at end of file" markers.
      i++;
      let minus = removed;
      let plus = added;
      while (i < lines.length && (minus > 0 || plus > 0 || lines[i].startsWith('\\'))) {
        const body = lines[i];
        if (body.startsWith('\\')) {
          i++;
          continue;
        }
        if (body.startsWith('-') && minus > 0) {
          minus--;
        } else if (body.startsWith('+') && plus > 0) {
          plus--;
        } else {
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  for (const [file, list] of result) {
    result.set(file, [...new Set(list)].sort((a, b) => a - b));
  }
  return result;
}

/** Splits NUL-terminated git output (`-z`). */
export function parseNulList(output: Buffer | string): string[] {
  return (typeof output === 'string' ? output : output.toString('utf8')).split('\0').filter((entry) => entry.length > 0);
}

/** Pathspec of the files coverage can apply to. */
const CSHARP_PATHSPEC = ':(icase)*.cs';

export interface NewCodeFile {
  /** Absolute path (in the folder space of the solution path). */
  path: string;
  /** Repository-relative path with forward slashes, as git prints it. */
  relativePath: string;
  lines: NewLines;
}

export interface NewCodeSnapshot {
  repositoryRoot: string;
  target: string;
  targetSource: 'setting' | 'auto';
  mergeBase: string;
  head?: string;
  /** Keyed by pathKey(path). */
  files: Map<string, NewCodeFile>;
  computedAt: number;
  durationMs: number;
}

export type NewCodeResult = { snapshot: NewCodeSnapshot; error?: undefined } | { snapshot?: undefined; error: string };

/** Computes the new code of the repository that contains `directory`. */
export async function computeNewCode(directory: string, targetSetting: string, run: GitRunner = runGit, now: () => number = Date.now): Promise<NewCodeResult> {
  const started = now();
  const repo = await repositoryRoot(directory, run);
  if (!repo) {
    return { error: `${directory} is not inside a git work tree` };
  }
  const target = await resolveTarget(repo, targetSetting, run);
  if (!target.ref) {
    return { error: target.error ?? 'no target branch' };
  }
  const base = await mergeBase(repo, target.ref, run);
  if (!base) {
    return { error: `HEAD and ${target.ref} have no merge base` };
  }
  const head = await headCommit(repo, run);

  // Working tree (staged and unstaged) against the merge base. Explicit options keep user
  // configuration (external diff tools, textconv, prefixes, quoting, colors) out of the output.
  const diff = await run(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '-U0',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--ignore-submodules',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
      '--',
      CSHARP_PATHSPEC,
    ],
    repo,
  );
  if (diff.code !== 0) {
    return { error: `git diff failed: ${diff.stderr.trim()}` };
  }
  const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z', '--', CSHARP_PATHSPEC], repo);
  if (untracked.code !== 0) {
    return { error: `git ls-files failed: ${untracked.stderr.trim()}` };
  }

  const files = new Map<string, NewCodeFile>();
  const add = (relativePath: string, lines: NewLines) => {
    const absolute = path.join(repo, ...relativePath.split('/'));
    files.set(pathKey(absolute), { path: absolute, relativePath, lines });
  };
  for (const [relativePath, lines] of parseDiffU0(diff.stdout.toString('utf8'))) {
    add(relativePath, lines);
  }
  for (const relativePath of parseNulList(untracked.stdout)) {
    add(relativePath, 'all');
  }
  return {
    snapshot: { repositoryRoot: repo, target: target.ref, targetSource: target.source!, mergeBase: base, head, files, computedAt: now(), durationMs: now() - started },
  };
}

/** Is `line` new in this file? */
export function isNewLine(lines: NewLines, line: number): boolean {
  if (lines === 'all') {
    return true;
  }
  // Binary search: the list is sorted.
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid] === line) {
      return true;
    }
    if (lines[mid] < line) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return false;
}
