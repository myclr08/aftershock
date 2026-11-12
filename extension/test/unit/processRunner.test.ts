import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { dotnetEnvironment, killProcessTree, runProcess } from '../../src/core/processRunner';
import { isAlive, waitFor } from './helpers';

const script = path.join(__dirname, '..', 'fixtures', 'scripts', 'tree.mjs');

function pidsFrom(lines: string[]): Record<string, number> {
  const pids: Record<string, number> = {};
  for (const line of lines) {
    const match = /^(child|grandchild) (\d+)$/.exec(line.trim());
    if (match) {
      pids[match[1]] = Number(match[2]);
    }
  }
  return pids;
}

describe('runProcess', () => {
  it('runs a command and captures its output and exit code', async () => {
    const result = await runProcess({ command: process.execPath, args: ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], cwd: __dirname });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(result.cancelled).toBe(false);
  });

  it('reports a command that cannot start', async () => {
    const result = await runProcess({ command: 'aftershock-no-such-command', args: [], cwd: __dirname });
    expect(result.spawnError).toBeDefined();
  });

  it('kills the whole process tree when cancelled', async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const running = runProcess({ command: process.execPath, args: [script, 'wait'], cwd: __dirname, signal: controller.signal, onLine: (line) => lines.push(line) });
    await waitFor(() => pidsFrom(lines).grandchild !== undefined);
    const pids = pidsFrom(lines);
    expect(isAlive(pids.child)).toBe(true);
    expect(isAlive(pids.grandchild)).toBe(true);

    controller.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    await waitFor(() => !isAlive(pids.child) && !isAlive(pids.grandchild), 5000);
  });

  it('does not wait for a grandchild that keeps the output pipe open', async () => {
    const lines: string[] = [];
    const started = Date.now();
    const result = await runProcess({ command: process.execPath, args: [script, 'exit'], cwd: __dirname, drainMs: 300, onLine: (line) => lines.push(line) });
    const pids = pidsFrom(lines);
    try {
      expect(result.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(isAlive(pids.grandchild)).toBe(true);
    } finally {
      await killProcessTree(pids.grandchild);
    }
  });

  it('kills the tree on timeout', async () => {
    const lines: string[] = [];
    const result = await runProcess({ command: process.execPath, args: [script, 'wait'], cwd: __dirname, timeoutMs: 1500, onLine: (line) => lines.push(line) });
    expect(result.timedOut).toBe(true);
    const pids = pidsFrom(lines);
    await waitFor(() => !isAlive(pids.child) && !isAlive(pids.grandchild), 5000);
  });

  it('returns at once for an already cancelled signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess({ command: process.execPath, args: ['-e', ''], cwd: __dirname, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.pid).toBeUndefined();
  });

  it('sets the MSBuild environment of DESIGN.md 6.1.1', () => {
    const env = dotnetEnvironment({ PATH: '/bin' });
    expect(env).toMatchObject({ PATH: '/bin', MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0' });
  });
});
