import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRestore, looksLikeMissingRestore, projectClosure, restoreInputs } from '../../src/core/restore';
import { tempDir, writeFile } from './helpers';

describe('restore check', () => {
  let dir: string;
  let cleanup: () => void;
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  let testProject: string;
  let coreProject: string;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    coreProject = path.join(dir, 'src', 'Core', 'Core.csproj');
    testProject = path.join(dir, 'tests', 'Core.Tests', 'Core.Tests.csproj');
    writeFile(coreProject, '<Project Sdk="Microsoft.NET.Sdk" />', T0);
    writeFile(testProject, '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\..\\src\\Core\\Core.csproj" /><ProjectReference Include="$(Shared)\\X.csproj" /></ItemGroup></Project>', T0);
    writeFile(path.join(dir, 'Directory.Build.props'), '<Project />', T0);
    writeFile(path.join(dir, 'tests', 'Core.Tests', 'obj', 'project.assets.json'), '{}', T0);
  });

  afterEach(() => cleanup());

  it('follows ProjectReferences (Windows separators, MSBuild properties skipped)', () => {
    expect(projectClosure(testProject).map((p) => path.relative(dir, p)).sort()).toEqual([path.join('src', 'Core', 'Core.csproj'), path.join('tests', 'Core.Tests', 'Core.Tests.csproj')].sort());
  });

  it('collects project files and global files above them', () => {
    writeFile(path.join(dir, 'NuGet.Config'), '<configuration />', T0);
    writeFile(path.join(dir, 'src', 'Directory.Packages.props'), '<Project />', T0);
    const inputs = restoreInputs(testProject).map((i) => path.relative(dir, i.file)).sort();
    expect(inputs).toEqual(['Directory.Build.props', 'NuGet.Config', path.join('src', 'Core', 'Core.csproj'), path.join('src', 'Directory.Packages.props'), path.join('tests', 'Core.Tests', 'Core.Tests.csproj')].sort());
  });

  it('restores on the first run', () => {
    expect(checkRestore(testProject, undefined)).toEqual({ needed: true, reason: 'first run' });
  });

  it('restores when project.assets.json is missing', () => {
    const check = checkRestore(path.join(dir, 'src', 'Core', 'Core.csproj'), T0 + 1000);
    expect(check.needed).toBe(true);
    expect(check.reason).toContain('project.assets.json is missing');
  });

  it('does not restore when nothing changed since the last restore', () => {
    expect(checkRestore(testProject, T0 + 1000)).toEqual({ needed: false, reason: 'up to date' });
  });

  it('restores when the test project, a referenced project or a global file is newer', () => {
    writeFile(coreProject, '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="X" /></ItemGroup></Project>', T0 + 5000);
    let check = checkRestore(testProject, T0 + 1000);
    expect(check.needed).toBe(true);
    expect(check.reason).toContain('Core.csproj');

    writeFile(coreProject, '<Project />', T0);
    writeFile(path.join(dir, 'global.json'), '{}', T0 + 5000);
    check = checkRestore(testProject, T0 + 1000);
    expect(check.needed).toBe(true);
    expect(check.reason).toContain('global.json');
  });

  it('uses the assets file location MSBuild reported', () => {
    expect(checkRestore(testProject, T0 + 1000, path.join(dir, 'artifacts', 'obj', 'Core.Tests', 'project.assets.json')).needed).toBe(true);
  });

  it('recognizes builds that failed for lack of restore output', () => {
    expect(looksLikeMissingRestore("error NETSDK1004: Assets file '/x/obj/project.assets.json' not found. Run a NuGet package restore")).toBe(true);
    expect(looksLikeMissingRestore('error CS1002: ; expected')).toBe(false);
  });
});
