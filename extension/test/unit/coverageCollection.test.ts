import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assetsFileOf, collectionPlan, hasPackage, missingPackageAdvice, referencedPackages } from '../../src/core/coverageCollection';
import { tempDir, writeFile } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function project(libraries: Record<string, { type: string }>, assetsPath = path.join('obj', 'project.assets.json')): string {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const csproj = path.join(dir, 'App.Tests', 'App.Tests.csproj');
  writeFile(csproj, '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFile(path.join(dir, 'App.Tests', assetsPath), `\uFEFF${JSON.stringify({ version: 3, libraries })}`);
  return csproj;
}

describe('coverage collection per tool and runner mode', () => {
  it('VSTest uses data collectors with Cobertura output', () => {
    expect(collectionPlan('coverlet', 'vstest')).toEqual({ args: ['--collect', 'XPlat Code Coverage;Format=cobertura'], requiredPackage: 'coverlet.collector' });
    expect(collectionPlan('microsoft', 'vstest')).toEqual({ args: ['--collect', 'Code Coverage;Format=cobertura'], requiredPackage: 'Microsoft.CodeCoverage' });
  });

  it('the bridge and MTP use the platform extensions', () => {
    for (const mode of ['bridge', 'mtp'] as const) {
      expect(collectionPlan('microsoft', mode)).toEqual({ args: ['--coverage', '--coverage-output-format', 'cobertura'], requiredPackage: 'Microsoft.Testing.Extensions.CodeCoverage' });
      expect(collectionPlan('coverlet', mode)).toEqual({ args: ['--coverlet', '--coverlet-output-format', 'cobertura'], requiredPackage: 'coverlet.MTP' });
    }
  });

  it('tells the user which package to add, and why coverlet.collector does not work under MTP', () => {
    expect(missingPackageAdvice('coverlet', 'vstest', 'App.Tests')).toContain('dotnet add "App.Tests" package coverlet.collector');
    const mtp = missingPackageAdvice('coverlet', 'mtp', 'App.Tests');
    expect(mtp).toContain('coverlet.MTP');
    expect(mtp).toContain('does not run under Microsoft.Testing.Platform');
    expect(mtp).toContain('Microsoft.Testing.Extensions.CodeCoverage');
    expect(missingPackageAdvice('microsoft', 'vstest', 'App.Tests')).toContain('Microsoft.NET.Test.Sdk');
    expect(missingPackageAdvice('microsoft', 'bridge', 'App.Tests')).toContain('Microsoft.Testing.Extensions.CodeCoverage');
  });
});

describe('package detection from project.assets.json', () => {
  it('finds direct and transitive packages, case-insensitively, and ignores project references', () => {
    const csproj = project({
      'coverlet.collector/6.0.4': { type: 'package' },
      'Microsoft.CodeCoverage/17.14.1': { type: 'package' },
      'Sample.Core/1.0.0': { type: 'project' },
    });
    expect(hasPackage(csproj, 'coverlet.collector')).toBe(true);
    expect(hasPackage(csproj, 'microsoft.codecoverage')).toBe(true);
    expect(hasPackage(csproj, 'coverlet.MTP')).toBe(false);
    expect(hasPackage(csproj, 'Sample.Core')).toBe(false);
  });

  it('uses ProjectAssetsFile when MSBuild reported one', () => {
    const csproj = project({ 'coverlet.MTP/8.0.0': { type: 'package' } }, path.join('..', 'artifacts', 'obj', 'App.Tests', 'project.assets.json'));
    expect(hasPackage(csproj, 'coverlet.MTP')).toBeUndefined();
    const custom = path.join('..', 'artifacts', 'obj', 'App.Tests', 'project.assets.json');
    expect(assetsFileOf(csproj, custom)).toBe(path.resolve(path.dirname(csproj), custom));
    expect(hasPackage(csproj, 'coverlet.MTP', custom)).toBe(true);
  });

  it('an unreadable assets file is "unknown", so collection is still attempted', () => {
    expect(referencedPackages(path.join(__dirname, 'does-not-exist.json'))).toBeUndefined();
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const broken = path.join(dir, 'obj', 'project.assets.json');
    writeFile(broken, '{ not json');
    expect(referencedPackages(broken)).toBeUndefined();
  });
});
