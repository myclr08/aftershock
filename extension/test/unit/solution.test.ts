import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareSolutionNames, discoverSolution } from '../../src/core/solution';
import { tempDir, writeFile } from './helpers';

describe('discoverSolution', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it('uses the setting (relative to the workspace folder)', () => {
    writeFile(path.join(dir, 'build', 'All.slnx'), '');
    const choice = discoverSolution(dir, 'build/All.slnx');
    expect(choice.solution).toBe(path.join(dir, 'build', 'All.slnx'));
  });

  it('reports a setting that points nowhere', () => {
    const choice = discoverSolution(dir, 'missing.sln');
    expect(choice.solution).toBeUndefined();
    expect(choice.message).toContain('does not exist');
  });

  it('picks the first solution in the root by name and says so', () => {
    writeFile(path.join(dir, 'Zeta.sln'), '');
    writeFile(path.join(dir, 'alpha.slnx'), '');
    writeFile(path.join(dir, 'Alpha.sln'), '');
    const choice = discoverSolution(dir, '');
    expect(path.basename(choice.solution!)).toBe('Alpha.sln');
    expect(choice.candidates.map((c) => path.basename(c))).toEqual(['Alpha.sln', 'alpha.slnx', 'Zeta.sln']);
    expect(choice.message).toContain('Found 3 solutions');
  });

  it('falls back to the shallowest nested solution, skipping bin/obj/node_modules', () => {
    writeFile(path.join(dir, 'node_modules', 'x', 'X.sln'), '');
    writeFile(path.join(dir, 'samples', 'deep', 'Deep.sln'), '');
    writeFile(path.join(dir, 'src', 'App.sln'), '');
    const choice = discoverSolution(dir, undefined);
    expect(choice.solution).toBe(path.join(dir, 'src', 'App.sln'));
    expect(choice.message).toContain('No solution in the workspace root');
  });

  it('finds nothing in an empty folder', () => {
    expect(discoverSolution(dir, '').solution).toBeUndefined();
  });

  it('orders .sln before .slnx of the same name', () => {
    expect(compareSolutionNames('/a/App.slnx', '/a/App.sln')).toBe(1);
  });
});
