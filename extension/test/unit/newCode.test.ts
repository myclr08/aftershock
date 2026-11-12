import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeNewCode, isNewLine, parseDiffU0, parseNulList, resolveTarget, runGit, unquoteGitPath } from '../../src/core/newCode';
import { pathKey } from '../../src/core/paths';
import { tempDir, writeFile } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Unit', '-c', 'user.email=unit@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout;
}

/** A repository with one commit on main; core.autocrlf is off so line endings stay as written. */
function repository(files: Record<string, string | Buffer>): string {
  const { dir, cleanup } = tempDir('aftershock-git-');
  cleanups.push(cleanup);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.quotePath', 'true');
  for (const [name, content] of Object.entries(files)) {
    write(dir, name, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function write(repo: string, name: string, content: string | Buffer): void {
  const file = path.join(repo, ...name.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const text = (rows: string[], eol = '\n') => rows.join(eol) + eol;

/** `git diff -U0` exactly as computeNewCode runs it (without the pathspec, to see every case). */
function diffOf(repo: string, base = 'HEAD'): string {
  return git(repo, '-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', base);
}

describe('git diff -U0 parsing (real git output)', () => {
  it('added and changed lines; pure deletions add nothing', () => {
    const repo = repository({ 'A.cs': text(lines(10)), 'B.cs': text(lines(10)) });
    const a = lines(10);
    a.splice(2, 1, 'changed 3'); // line 3 changed
    a.splice(5, 0, 'new 6a', 'new 6b'); // two lines inserted after line 5 -> new lines 6, 7
    write(repo, 'A.cs', text(a));
    const b = lines(10);
    b.splice(3, 2); // lines 4 and 5 deleted
    write(repo, 'B.cs', text(b));
    const output = diffOf(repo);
    expect(output).toContain('@@ -4,2 +3,0 @@');
    const parsed = parseDiffU0(output);
    expect(parsed.get('A.cs')).toEqual([3, 6, 7]);
    expect(parsed.has('B.cs')).toBe(false);
  });

  it('CRLF files: line numbers are the same as with LF', () => {
    const repo = repository({ 'Crlf.cs': text(lines(6), '\r\n') });
    const rows = lines(6);
    rows[4] = 'changed 5';
    rows.push('new 7');
    write(repo, 'Crlf.cs', text(rows, '\r\n'));
    const output = diffOf(repo);
    expect(output).toContain('\r\n');
    expect(parseDiffU0(output).get('Crlf.cs')).toEqual([5, 7]);
  });

  it('renames (staged) report only the changed lines under the new name; a pure rename reports nothing', () => {
    const repo = repository({ 'src/Old.cs': text(lines(30)), 'src/Same.cs': text(lines(30, 'same')) });
    git(repo, 'mv', 'src/Old.cs', 'src/New.cs');
    git(repo, 'mv', 'src/Same.cs', 'src/Moved.cs');
    const rows = lines(30);
    rows[9] = 'changed 10';
    write(repo, 'src/New.cs', text(rows));
    const output = diffOf(repo);
    expect(output).toContain('rename from src/Old.cs');
    expect(output).toContain('rename to src/Moved.cs');
    const parsed = parseDiffU0(output);
    expect(parsed.get('src/New.cs')).toEqual([10]);
    expect(parsed.has('src/Moved.cs')).toBe(false);
    expect(parsed.has('src/Old.cs')).toBe(false);
  });

  it('deleted files, binary files and mode changes add nothing', () => {
    const repo = repository({ 'Gone.cs': text(lines(3)), 'Data.cs': Buffer.from([0, 1, 2, 3, 0]), 'Mode.cs': text(lines(2)) });
    fs.rmSync(path.join(repo, 'Gone.cs'));
    write(repo, 'Data.cs', Buffer.from([0, 9, 9, 9, 0, 1]));
    git(repo, 'update-index', '--chmod=+x', 'Mode.cs');
    const output = diffOf(repo);
    expect(output).toContain('Binary files');
    expect(output).toContain('deleted file mode');
    expect(parseDiffU0(output).size).toBe(0);
  });

  it('paths with spaces and non-ASCII characters', () => {
    const repo = repository({ 'src/My Folder/Ödeme Servisi.cs': text(lines(3)), 'src/x y.cs': text(lines(3)) });
    write(repo, 'src/My Folder/Ödeme Servisi.cs', text([...lines(3), 'new 4']));
    write(repo, 'src/x y.cs', text(['changed 1', 'line 2', 'line 3']));
    const parsed = parseDiffU0(diffOf(repo));
    expect(parsed.get('src/My Folder/Ödeme Servisi.cs')).toEqual([4]);
    expect(parsed.get('src/x y.cs')).toEqual([1]);
  });

  it('a content line that looks like a file header is not taken for one', () => {
    const repo = repository({ 'A.cs': text(lines(3)), 'B.cs': text(lines(3)) });
    write(repo, 'A.cs', text(['line 1', '++ b/B.cs', 'line 2', 'line 3']));
    write(repo, 'B.cs', text(['line 1', 'line 2', '-- a/A.cs', 'line 3']));
    const parsed = parseDiffU0(diffOf(repo));
    expect(parsed.get('A.cs')).toEqual([2]);
    expect(parsed.get('B.cs')).toEqual([3]);
  });

  it('quoted paths (core.quotePath on) are unquoted, octal escapes as UTF-8', () => {
    const output = ['diff --git "a/src/\\303\\226deme.cs" "b/src/\\303\\226deme.cs"', '--- "a/src/\\303\\226deme.cs"', '+++ "b/src/\\303\\226deme.cs"', '@@ -2 +2,2 @@', '-x', '+y', '+z', ''].join('\n');
    expect(parseDiffU0(output).get('src/Ödeme.cs')).toEqual([2, 3]);
    expect(unquoteGitPath('"a\\tb\\"c\\\\d"')).toBe('a\tb"c\\d');
    expect(unquoteGitPath('plain.cs')).toBe('plain.cs');
  });

  it('hunk headers without counts mean one line; "\\ No newline" markers are skipped', () => {
    const output = ['diff --git a/A.cs b/A.cs', '--- a/A.cs', '+++ b/A.cs', '@@ -5 +5 @@', '-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file', '@@ -9,0 +10,2 @@', '+a', '+b', ''].join('\n');
    expect(parseDiffU0(output).get('A.cs')).toEqual([5, 10, 11]);
  });

  it('NUL-separated lists and isNewLine', () => {
    expect(parseNulList(Buffer.from('a.cs\0b c.cs\0'))).toEqual(['a.cs', 'b c.cs']);
    expect(isNewLine([3, 6, 7, 20], 7)).toBe(true);
    expect(isNewLine([3, 6, 7, 20], 8)).toBe(false);
    expect(isNewLine('all', 12345)).toBe(true);
  });
});

describe('target branch and new code', () => {
  function feature(): string {
    const repo = repository({ 'src/A.cs': text(lines(10)), 'src/B.cs': text(lines(10)), 'README.md': 'x\n' });
    return repo;
  }

  it('without a remote branch: a clear error that names the setting', async () => {
    const repo = feature();
    const result = await computeNewCode(repo, '');
    expect(result.error).toMatch(/origin\/HEAD, origin\/main, origin\/master, origin\/develop/);
    expect(result.error).toMatch(/aftershock\.targetBranch/);
  });

  it('automatic order: origin/HEAD, then origin/main, origin/master, origin/develop', async () => {
    const repo = feature();
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-ref', 'refs/remotes/origin/develop', head);
    expect(await resolveTarget(repo, '')).toEqual({ ref: 'origin/develop', source: 'auto' });
    git(repo, 'update-ref', 'refs/remotes/origin/master', head);
    expect((await resolveTarget(repo, '')).ref).toBe('origin/master');
    git(repo, 'update-ref', 'refs/remotes/origin/main', head);
    expect((await resolveTarget(repo, '')).ref).toBe('origin/main');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    expect((await resolveTarget(repo, '')).ref).toBe('origin/HEAD');
    expect(await resolveTarget(repo, 'main')).toEqual({ ref: 'main', source: 'setting' });
    expect((await resolveTarget(repo, 'origin/nope')).error).toMatch(/aftershock\.targetBranch "origin\/nope" does not resolve/);
    expect((await resolveTarget(repo, '--output=x')).error).toBeDefined();
  });

  it('new code = merge base of HEAD and the target vs the working tree, plus untracked files; the target moving on does not count', async () => {
    const repo = feature();
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'feature');
    // Committed on the feature branch: new.
    write(repo, 'src/A.cs', text([...lines(10), 'committed 11']));
    git(repo, 'commit', '-q', '-am', 'feature work');
    // The target moves on with an unrelated commit: not new code of this branch.
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'src/C.cs', text(lines(3)));
    git(repo, 'add', 'src/C.cs');
    git(repo, 'commit', '-q', '-m', 'main moves on');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'checkout', '-q', 'feature');
    // Staged and unstaged: new.
    write(repo, 'src/B.cs', text(['staged 1', ...lines(10).slice(1)]));
    git(repo, 'add', 'src/B.cs');
    write(repo, 'src/B.cs', text(['staged 1', ...lines(10).slice(1, 9), 'unstaged 10']));
    // Untracked: every line; not C#: ignored; ignored files: ignored.
    write(repo, 'src/New Folder/Brand New.cs', text(lines(4)));
    write(repo, 'notes.txt', 'x\n');
    write(repo, '.gitignore', 'bin/\n');
    write(repo, 'src/bin/Gen.cs', text(lines(2)));

    const result = await computeNewCode(path.join(repo, 'src'), '');
    expect(result.error).toBeUndefined();
    const snapshot = result.snapshot!;
    expect(snapshot.target).toBe('origin/main');
    expect(snapshot.mergeBase).toBe(git(repo, 'merge-base', 'HEAD', 'origin/main').trim());
    expect(fs.realpathSync.native(snapshot.repositoryRoot)).toBe(fs.realpathSync.native(repo));
    const byName = new Map([...snapshot.files.values()].map((f) => [f.relativePath, f.lines]));
    expect(byName.get('src/A.cs')).toEqual([11]);
    expect(byName.get('src/B.cs')).toEqual([1, 10]);
    expect(byName.get('src/New Folder/Brand New.cs')).toBe('all');
    expect(byName.has('src/C.cs')).toBe(false);
    expect(byName.has('notes.txt')).toBe(false);
    expect(byName.has('src/bin/Gen.cs')).toBe(false);
    // Keys are absolute paths below the repository root.
    const a = [...snapshot.files.values()].find((f) => f.relativePath === 'src/A.cs')!;
    expect(snapshot.files.has(pathKey(path.join(repo, 'src', 'A.cs')))).toBe(true);
    expect(a.path).toBe(path.join(snapshot.repositoryRoot, 'src', 'A.cs'));
  });

  it('a directory outside git', async () => {
    const { dir, cleanup } = tempDir('aftershock-nogit-');
    cleanups.push(cleanup);
    const result = await computeNewCode(dir, '', (args, cwd) => runGit(args, cwd));
    expect(result.error).toMatch(/not inside a git work tree/);
  });

  it('upper-case .CS files count too', async () => {
    const repo = feature();
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFile(path.join(repo, 'src', 'Legacy.CS'), text(lines(2)));
    const result = await computeNewCode(repo, '');
    expect([...result.snapshot!.files.values()].map((f) => f.relativePath)).toEqual(['src/Legacy.CS']);
  });
});
