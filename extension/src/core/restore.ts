import * as fs from 'fs';
import * as path from 'path';
import { pathKey } from './paths';

/** Build inputs that change what `dotnet restore` produces, looked up in every folder above a project. */
export const GLOBAL_RESTORE_FILES = ['directory.build.props', 'directory.build.targets', 'directory.packages.props', 'global.json', 'nuget.config'];

export interface RestoreCheck {
  needed: boolean;
  reason: string;
}

export interface RestoreInput {
  file: string;
  mtimeMs: number;
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** `<ProjectReference Include="..\X\X.csproj" />` targets of a project file (MSBuild properties are skipped). */
export function projectReferences(projectFile: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(projectFile, 'utf8');
  } catch {
    return [];
  }
  const references: string[] = [];
  const pattern = /<ProjectReference\b[^>]*?\bInclude\s*=\s*"([^"]+)"/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    for (const include of match[1].split(';')) {
      const value = include.trim();
      if (!value || value.includes('$(') || value.includes('*')) {
        continue;
      }
      references.push(path.resolve(path.dirname(projectFile), value.replace(/\\/g, path.sep).replace(/\//g, path.sep)));
    }
  }
  return references;
}

/** The project and its ProjectReference closure. */
export function projectClosure(projectFile: string): string[] {
  const seen = new Map<string, string>();
  const queue = [path.resolve(projectFile)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = pathKey(current);
    if (seen.has(key) || !fs.existsSync(current)) {
      continue;
    }
    seen.set(key, current);
    queue.push(...projectReferences(current));
  }
  return [...seen.values()];
}

function globalFilesAbove(directory: string, cache: Map<string, string[]>): string[] {
  const found: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    let files = cache.get(current);
    if (!files) {
      files = [];
      try {
        for (const entry of fs.readdirSync(current)) {
          if (GLOBAL_RESTORE_FILES.includes(entry.toLowerCase())) {
            files.push(path.join(current, entry));
          }
        }
      } catch {
        // Unreadable folder: nothing to add.
      }
      cache.set(current, files);
    }
    found.push(...files);
    const parent = path.dirname(current);
    if (parent === current) {
      return found;
    }
    current = parent;
  }
}

/**
 * Every file whose change can require a new restore of `projectFile`: the project files of its
 * ProjectReference closure and the global props/package/SDK files above any of them.
 */
export function restoreInputs(projectFile: string): RestoreInput[] {
  const cache = new Map<string, string[]>();
  const files = new Map<string, string>();
  for (const project of projectClosure(projectFile)) {
    files.set(pathKey(project), project);
    for (const file of globalFilesAbove(path.dirname(project), cache)) {
      files.set(pathKey(file), file);
    }
  }
  const inputs: RestoreInput[] = [];
  for (const file of files.values()) {
    const time = mtime(file);
    if (time !== undefined) {
      inputs.push({ file, mtimeMs: time });
    }
  }
  return inputs;
}

/**
 * DESIGN.md 6.1: restore on the first run, when the assets file is missing, or when a project file or a
 * global props/package file is newer than the last successful restore.
 */
export function checkRestore(projectFile: string, lastRestoreMs: number | undefined, assetsFile?: string): RestoreCheck {
  if (lastRestoreMs === undefined) {
    return { needed: true, reason: 'first run' };
  }
  const assets = assetsFile ?? path.join(path.dirname(projectFile), 'obj', 'project.assets.json');
  if (!fs.existsSync(assets)) {
    return { needed: true, reason: `${assets} is missing` };
  }
  const newer = restoreInputs(projectFile).filter((input) => input.mtimeMs > lastRestoreMs);
  if (newer.length > 0) {
    newer.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { needed: true, reason: `${newer[0].file} changed after the last restore` };
  }
  return { needed: false, reason: 'up to date' };
}

/** Newest modification time among the restore inputs (cache key for per-project data). */
export function newestRestoreInput(projectFile: string): number {
  return restoreInputs(projectFile).reduce((max, input) => Math.max(max, input.mtimeMs), 0);
}

/** Output of a build that failed because restore output was missing (NETSDK1004 and friends). */
export function looksLikeMissingRestore(buildOutput: string): boolean {
  return /\bNETSDK1004\b|\bNETSDK1005\b|\bNETSDK1047\b|project\.assets\.json' not found/i.test(buildOutput);
}
