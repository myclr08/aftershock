import * as fs from 'fs';
import * as path from 'path';
import type { RunnerMode } from './runnerMode';

/**
 * How coverage is collected per coverage tool and test runner mode (DESIGN.md 7.2):
 *
 * | Tool | VSTest | Bridge / Microsoft.Testing.Platform |
 * |---|---|---|
 * | coverlet | `--collect "XPlat Code Coverage;Format=cobertura"` (coverlet.collector) | `--coverlet --coverlet-output-format cobertura` (coverlet.MTP) |
 * | microsoft | `--collect "Code Coverage;Format=cobertura"` (Microsoft.CodeCoverage, part of Microsoft.NET.Test.Sdk) | `--coverage --coverage-output-format cobertura` (Microsoft.Testing.Extensions.CodeCoverage) |
 *
 * VSTest data collectors (coverlet.collector) do not run under Microsoft.Testing.Platform: the bridge
 * ignores `--collect`, and the platform needs its own extension.
 */
export type CoverageTool = 'coverlet' | 'microsoft';

export interface CollectionPlan {
  /** Extra `dotnet test` arguments (in bridge/MTP mode: test application options). */
  args: string[];
  /** The NuGet package that must be referenced by the test project. */
  requiredPackage: string;
}

export function collectionPlan(tool: CoverageTool, mode: RunnerMode): CollectionPlan {
  if (mode === 'vstest') {
    return tool === 'microsoft'
      ? { args: ['--collect', 'Code Coverage;Format=cobertura'], requiredPackage: 'Microsoft.CodeCoverage' }
      : { args: ['--collect', 'XPlat Code Coverage;Format=cobertura'], requiredPackage: 'coverlet.collector' };
  }
  return tool === 'microsoft'
    ? { args: ['--coverage', '--coverage-output-format', 'cobertura'], requiredPackage: 'Microsoft.Testing.Extensions.CodeCoverage' }
    : { args: ['--coverlet', '--coverlet-output-format', 'cobertura'], requiredPackage: 'coverlet.MTP' };
}

/** What to tell the user when the package is missing. */
export function missingPackageAdvice(tool: CoverageTool, mode: RunnerMode, projectName: string): string {
  const plan = collectionPlan(tool, mode);
  const modeName = mode === 'vstest' ? 'VSTest' : mode === 'bridge' ? 'the VSTest bridge (Microsoft.Testing.Platform)' : 'Microsoft.Testing.Platform';
  const base = `${projectName} runs on ${modeName} and does not reference ${plan.requiredPackage}, so no coverage is collected for it. Add the package to the test project (dotnet add "${projectName}" package ${plan.requiredPackage})`;
  if (tool === 'coverlet' && mode !== 'vstest') {
    return `${base}; coverlet.collector is a VSTest data collector and does not run under Microsoft.Testing.Platform. Alternatively set aftershock.coverageTool to "microsoft" and add Microsoft.Testing.Extensions.CodeCoverage.`;
  }
  if (tool === 'microsoft' && mode === 'vstest') {
    return `${base} (it comes with Microsoft.NET.Test.Sdk; update that package if it is missing).`;
  }
  return `${base}.`;
}

interface AssetsCacheEntry {
  mtimeMs: number;
  size: number;
  libraries: Set<string>;
}

const assetsCache = new Map<string, AssetsCacheEntry>();

/**
 * Package ids (lower case) in a project's `project.assets.json` (direct and transitive), or undefined
 * when the file cannot be read. Cached by modification time.
 */
export function referencedPackages(assetsFile: string): Set<string> | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(assetsFile);
  } catch {
    return undefined;
  }
  const cached = assetsCache.get(assetsFile);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.libraries;
  }
  try {
    const json = JSON.parse(fs.readFileSync(assetsFile, 'utf8').replace(/^\uFEFF/, '')) as { libraries?: Record<string, { type?: string }> };
    const libraries = new Set<string>();
    for (const [key, value] of Object.entries(json.libraries ?? {})) {
      if (value?.type === 'project') {
        continue;
      }
      libraries.add(key.slice(0, key.indexOf('/') >= 0 ? key.indexOf('/') : key.length).toLowerCase());
    }
    assetsCache.set(assetsFile, { mtimeMs: stat.mtimeMs, size: stat.size, libraries });
    return libraries;
  } catch {
    return undefined;
  }
}

/** The assets file of a project: `ProjectAssetsFile` when known, else `obj/project.assets.json`. */
export function assetsFileOf(projectPath: string, projectAssetsFile?: string): string {
  if (projectAssetsFile && projectAssetsFile.trim()) {
    return path.resolve(path.dirname(projectPath), projectAssetsFile.trim());
  }
  return path.join(path.dirname(projectPath), 'obj', 'project.assets.json');
}

/** true / false, or undefined when the assets file cannot be read (then collection is attempted anyway). */
export function hasPackage(projectPath: string, packageId: string, projectAssetsFile?: string): boolean | undefined {
  const packages = referencedPackages(assetsFileOf(projectPath, projectAssetsFile));
  return packages ? packages.has(packageId.toLowerCase()) : undefined;
}
