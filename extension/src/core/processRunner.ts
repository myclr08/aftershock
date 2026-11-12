import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Called for every complete output line (stdout and stderr). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Called once the child has a PID (tests use it to inspect the process tree). */
  onSpawn?: (pid: number) => void;
  /**
   * After the process exits, wait at most this long for the output streams to end. Grandchildren
   * (MSBuild nodes, the compiler server) can inherit the pipes and keep them open long after the
   * command has finished (DESIGN.md 6.1.1), so EOF is never awaited without a limit.
   */
  drainMs?: number;
  /** Kill the tree when the command runs longer than this. */
  timeoutMs?: number;
  /** Keep at most this many characters of output (the oldest part is dropped). */
  maxOutputChars?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Combined stdout + stderr, possibly truncated at the start. */
  output: string;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
  pid?: number;
  /** The process could not be started (for example the dotnet path is wrong). */
  spawnError?: Error;
}

export type ProcessRunner = (options: RunOptions) => Promise<RunResult>;

/**
 * Environment for every dotnet child process (DESIGN.md 6.1.1): no MSBuild node reuse and no MSBuild
 * server, so no long-lived process inherits our pipes or survives a cancellation.
 */
export function dotnetEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    MSBUILDDISABLENODEREUSE: '1',
    DOTNET_CLI_USE_MSBUILD_SERVER: '0',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  };
}

/**
 * Spawn options that make the whole process tree killable: on POSIX the child leads a new process
 * group (killed with `kill(-pid)`), on Windows `taskkill /T` walks the tree.
 */
export function treeSpawnOptions(cwd: string, env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform = process.platform): SpawnOptions {
  return {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

/** Kills a process and all its descendants. Never throws. */
export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(resolve, 10000);
        killer.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        killer.once('error', () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        resolve();
      }
    });
    return;
  }
  try {
    // Negative PID: the whole process group the child leads (it was spawned detached).
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

class OutputBuffer {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly max: number) {}

  add(text: string): void {
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > this.max && this.chunks.length > 1) {
      this.length -= this.chunks.shift()!.length;
    }
  }

  toString(): string {
    const text = this.chunks.join('');
    return text.length > this.max ? text.slice(text.length - this.max) : text;
  }
}

/** Runs a command without a shell; kills its whole tree on cancellation or timeout. */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const drainMs = options.drainMs ?? 2000;
  const output = new OutputBuffer(options.maxOutputChars ?? 4_000_000);

  if (options.signal?.aborted) {
    return Promise.resolve({ exitCode: null, signal: null, output: '', durationMs: 0, cancelled: true, timedOut: false });
  }

  return new Promise<RunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], treeSpawnOptions(options.cwd, options.env));
    } catch (error) {
      resolve({ exitCode: null, signal: null, output: '', durationMs: Date.now() - started, cancelled: false, timedOut: false, spawnError: error as Error });
      return;
    }

    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    const openStreams = new Set<string>();

    const emitLines = (stream: 'stdout' | 'stderr', text: string, flush: boolean): void => {
      pending[stream] += text;
      let newline = pending[stream].indexOf('\n');
      while (newline >= 0) {
        const line = pending[stream].slice(0, newline).replace(/\r$/, '');
        pending[stream] = pending[stream].slice(newline + 1);
        options.onLine?.(line, stream);
        newline = pending[stream].indexOf('\n');
      }
      if (flush && pending[stream].length > 0) {
        options.onLine?.(pending[stream].replace(/\r$/, ''), stream);
        pending[stream] = '';
      }
    };

    for (const name of ['stdout', 'stderr'] as const) {
      const stream = child[name];
      if (!stream) {
        continue;
      }
      openStreams.add(name);
      stream.setEncoding('utf8');
      stream.on('data', (data: string) => {
        output.add(data);
        emitLines(name, data, false);
      });
      stream.once('close', () => openStreams.delete(name));
    }

    const kill = (): void => {
      if (child.pid !== undefined) {
        void killProcessTree(child.pid);
      }
    };

    const onAbort = (): void => {
      if (!settled) {
        cancelled = true;
        kill();
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      emitLines('stdout', '', true);
      emitLines('stderr', '', true);
      // Do not keep the event loop busy with pipes a grandchild still holds.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode,
        signal,
        output: output.toString(),
        durationMs: Date.now() - started,
        cancelled,
        timedOut,
        pid: child.pid,
        spawnError,
      });
    };

    child.once('error', (error) => finish(null, null, error));
    child.once('exit', (code, signal) => {
      // Wait for the remaining output, but only for a bounded time.
      const deadline = Date.now() + drainMs;
      const poll = (): void => {
        if (openStreams.size === 0 || Date.now() >= deadline) {
          finish(code, signal);
        } else {
          setTimeout(poll, 20);
        }
      };
      poll();
    });

    if (child.pid !== undefined) {
      options.onSpawn?.(child.pid);
    }
  });
}
