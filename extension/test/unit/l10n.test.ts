import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('localization', () => {
  it('translates every runtime string (vscode.l10n.t) into Turkish', () => {
    const bundle = read('l10n/bundle.l10n.tr.json');
    const keys = new Set<string>();
    for (const file of sourceFiles(path.join(root, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        keys.add(match[1].replace(/\\'/g, "'"));
      }
    }
    expect(keys.size).toBeGreaterThan(20);
    const missing = [...keys].filter((key) => !(key in bundle));
    expect(missing).toEqual([]);
    const unused = Object.keys(bundle).filter((key) => !keys.has(key));
    expect(unused).toEqual([]);
    for (const key of keys) {
      const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
      expect(placeholders(String(bundle[key])), key).toBe(placeholders(key));
    }
  });

  it('has a Turkish entry for every contribution string, and every %key% is defined', () => {
    const english = read('package.nls.json');
    const turkish = read('package.nls.tr.json');
    expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
    const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const used = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
    expect(used.filter((key) => !(key in english))).toEqual([]);
    expect(Object.keys(english).filter((key) => !used.includes(key))).toEqual([]);
  });

  it('contributes the M3 and M4 settings, commands and colors', () => {
    const manifest = read('package.json') as {
      contributes: { configuration: { properties: Record<string, unknown> }; commands: { command: string }[]; colors: { id: string; defaults: Record<string, string> }[] };
      activationEvents: string[];
    };
    expect(Object.keys(manifest.contributes.configuration.properties).sort()).toEqual(
      [
        'aftershock.debounceMs',
        'aftershock.disableAnalyzersInBuild',
        'aftershock.dotnetPath',
        'aftershock.fallbackGlobs',
        'aftershock.maxImpactedSymbols',
        'aftershock.solution',
        'aftershock.testFilter',
        'aftershock.targetBranch',
        'aftershock.coverageThreshold',
        'aftershock.coverageEnabled',
        'aftershock.coverageTool',
        'aftershock.coverageExclusions',
        'aftershock.coverageDecorations',
      ].sort(),
    );
    expect(manifest.contributes.commands.map((c) => c.command).sort()).toEqual(
      ['aftershock.recomputeCoverage', 'aftershock.restartAnalyzer', 'aftershock.runAllTests', 'aftershock.showImpactedTests', 'aftershock.showOutput', 'aftershock.togglePause'].sort(),
    );
    // Every color the decorations use is contributed, for light, dark and both high-contrast themes.
    const decorations = fs.readFileSync(path.join(root, 'src', 'vscode', 'coverageDecorations.ts'), 'utf8');
    const used = [...decorations.matchAll(/ThemeColor\('([^']+)'\)/g)].map((m) => m[1]).sort();
    expect(manifest.contributes.colors.map((c) => c.id).sort()).toEqual(used);
    for (const color of manifest.contributes.colors) {
      expect(Object.keys(color.defaults).sort(), color.id).toEqual(['dark', 'highContrast', 'highContrastLight', 'light']);
    }
    for (const icon of decorations.matchAll(/icon\('([^']+)'\)/g)) {
      expect(fs.existsSync(path.join(root, 'media', `coverage-${icon[1]}.svg`)), icon[1]).toBe(true);
    }
    expect(manifest.activationEvents).toEqual(['workspaceContains:**/*.sln', 'workspaceContains:**/*.slnx', 'workspaceContains:**/*.csproj']);
  });
});
