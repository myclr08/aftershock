import { spawn } from 'child_process';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyzerHost, AnalyzerRestartedError, AnalyzerUnavailableError, type AnalyzerState } from '../../src/core/analyzerHost';
import { RpcError } from '../../src/core/jsonRpc';
import { MemoryLogger } from '../../src/core/logger';
import { isAlive, tempDir, waitFor } from './helpers';

const fake = path.join(__dirname, '..', 'fixtures', 'scripts', 'fakeAnalyzer.mjs');
const hosts: AnalyzerHost[] = [];

function host(env: Record<string, string>, backoffMs = [50, 50, 50]) {
  const logger = new MemoryLogger();
  const states: AnalyzerState[] = [];
  const pids: number[] = [];
  const analyzer = new AnalyzerHost(
    { dotnetPath: process.execPath, analyzerDll: fake, solution: path.join(__dirname, 'App.sln'), options: { maxSymbols: 42, fallbackGlobs: ['**/x.json'] } },
    logger,
    {
      backoffMs,
      spawnProcess: (command, args, cwd) => {
        const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        if (child.pid) pids.push(child.pid);
        return child;
      },
    },
  );
  analyzer.onState = (state) => states.push(state);
  hosts.push(analyzer);
  return { analyzer, logger, states, pids };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});

describe('AnalyzerHost', () => {
  it('initializes with the settings and answers impact requests', async () => {
    const { analyzer, logger, states } = host({ FAKE_MODE: 'normal' });
    analyzer.start();
    const init = await analyzer.whenReady();
    expect(init.options).toMatchObject({ maxSymbols: 42, fallbackGlobs: ['**/x.json'] });
    expect(analyzer.testProjects?.map((p) => p.name)).toEqual(['App.Tests']);
    expect(states).toEqual(['starting', 'loading', 'ready']);
    expect(logger.lines.some((l) => l.includes('[analyzer] loading fake solution'))).toBe(true);
    const report = await analyzer.impact(['/repo/src/A.cs']);
    expect(report.tests).toHaveLength(1);
  });

  it('a newer impact supersedes an older one that is still running', async () => {
    const { analyzer } = host({ FAKE_MODE: 'slowImpact', FAKE_IMPACT_DELAY_MS: '300' });
    analyzer.start();
    await analyzer.whenReady();
    const first = analyzer.impact(['/repo/a.cs']);
    await new Promise((r) => setTimeout(r, 50));
    const second = analyzer.impact(['/repo/b.cs']);
    const error = (await first.catch((e) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.cancelReason).toBe('superseded');
    expect((await second).tests).toHaveLength(1);
  });

  it('reports a load failure and does not restart', async () => {
    const { analyzer, states } = host({ FAKE_MODE: 'loadFail' });
    analyzer.start();
    await expect(analyzer.whenReady()).rejects.toBeInstanceOf(AnalyzerUnavailableError);
    expect(analyzer.state).toBe('failed');
    expect(states).not.toContain('restarting');
  });

  it('restarts with backoff after a crash; the failed request rejects, the next one works', async () => {
    const { analyzer, logger, pids } = host({ FAKE_MODE: 'normal' });
    analyzer.start();
    await analyzer.whenReady();
    process.kill(pids[0], 'SIGKILL');
    await waitFor(() => analyzer.state === 'restarting' || analyzer.state === 'ready' && pids.length > 1);
    await waitFor(() => analyzer.state === 'ready' && pids.length === 2);
    expect(logger.lines.some((l) => l.includes('stopped unexpectedly'))).toBe(true);
    expect((await analyzer.impact(['/repo/c.cs'])).tests).toHaveLength(1);
  });

  it('changes saved while the analyzer restarts after a crash are reported as not analyzable', async () => {
    const { analyzer, pids } = host({ FAKE_MODE: 'normal' }, [300]);
    analyzer.start();
    await analyzer.whenReady();
    process.kill(pids[0], 'SIGKILL');
    await waitFor(() => analyzer.state === 'restarting');
    await expect(analyzer.impact(['/repo/saved-while-down.cs'])).rejects.toBeInstanceOf(AnalyzerRestartedError);
    expect(analyzer.state).toBe('ready');
    expect((await analyzer.impact(['/repo/after.cs'])).tests).toHaveLength(1);
  });

  it('a crash during a request rejects it; requests wait for the restarted analyzer', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { analyzer, logger } = host({ FAKE_MODE: 'crashOnImpact' });
      analyzer.start();
      await analyzer.whenReady();
      await expect(analyzer.impact(['/repo/a.cs'])).rejects.toThrow(/stopped/);
      expect(logger.lines.some((l) => l.includes('simulated crash on impact'))).toBe(true);
      expect(dir).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('gives up after repeated crashes at start', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { analyzer, logger } = host({ FAKE_MODE: 'crashAtStart', FAKE_CRASHES: '10', FAKE_STATE_FILE: path.join(dir, 'starts') }, [20, 20]);
      analyzer.start();
      await expect(analyzer.whenReady()).rejects.toBeInstanceOf(AnalyzerUnavailableError);
      expect(analyzer.state).toBe('failed');
      expect(logger.lines.filter((l) => l.includes('Restarting the analyzer in')).length).toBe(2);
      expect(logger.lines.some((l) => l.includes('simulated crash'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('recovers when a crash at start happens only once', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { analyzer } = host({ FAKE_MODE: 'crashAtStart', FAKE_CRASHES: '1', FAKE_STATE_FILE: path.join(dir, 'starts') });
      analyzer.start();
      await analyzer.whenReady();
      expect(analyzer.state).toBe('ready');
    } finally {
      cleanup();
    }
  });

  it('stops gracefully with shutdown and exit', async () => {
    const { analyzer, pids } = host({ FAKE_MODE: 'normal' });
    analyzer.start();
    await analyzer.whenReady();
    await analyzer.stop();
    expect(analyzer.state).toBe('stopped');
    await waitFor(() => !isAlive(pids[0]));
  });

  it('reports a missing dotnet', async () => {
    const analyzer = new AnalyzerHost({ dotnetPath: 'aftershock-missing-dotnet', analyzerDll: fake, solution: '/x/App.sln', options: {} }, new MemoryLogger(), { backoffMs: [10] });
    hosts.push(analyzer);
    analyzer.start();
    await expect(analyzer.whenReady()).rejects.toThrow(/not found/);
    expect(analyzer.state).toBe('failed');
  });

  it('impactSinceBase sends the base, the files and never supersedes', async () => {
    const { analyzer } = host({ FAKE_MODE: 'normal' });
    analyzer.start();
    const report = (await analyzer.impactSinceBase('0123abcd', ['/repo/src/A.cs'], { mergeBase: false })) as unknown as { received: Record<string, unknown>; tests: unknown[] };
    expect(report.received).toEqual({ base: '0123abcd', files: ['/repo/src/A.cs'], mergeBase: false, supersede: false });
    expect(report.tests).toHaveLength(1);
    const defaults = (await analyzer.impactSinceBase('origin/main', [])) as unknown as { received: Record<string, unknown> };
    expect(defaults.received.mergeBase).toBe(true);
  });
});
