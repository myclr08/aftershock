import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import type {
  AnalyzerOptions,
  ImpactReport,
  InitializeResult,
  LogNotification,
  ProgressNotification,
  ReloadResult,
  WorkspaceTestProject,
} from './analyzerProtocol';
import { ConnectionClosedError, JsonRpcConnection, RpcError } from './jsonRpc';
import { formatDuration, type Logger } from './logger';
import { formatCommand } from './paths';
import { dotnetEnvironment, killProcessTree } from './processRunner';

export interface AnalyzerLaunch {
  dotnetPath: string;
  /** `aftershock-analyzer.dll`. */
  analyzerDll: string;
  solution: string;
  options: AnalyzerOptions;
}

export type AnalyzerState = 'stopped' | 'starting' | 'loading' | 'ready' | 'failed' | 'restarting';

export interface AnalyzerHostOptions {
  /** Restart delays after consecutive crashes; after the last one the host gives up. */
  backoffMs?: number[];
  /** A process that lived this long resets the crash count. */
  stableAfterMs?: number;
  /** Starts the analyzer process (tests substitute a fake server). */
  spawnProcess?: (command: string, args: string[], cwd: string) => ChildProcess;
}

export class AnalyzerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzerUnavailableError';
  }
}

/**
 * The analyzer crashed and was restarted while files were waiting to be analyzed. The new process took
 * its snapshot from disk, so those changes cannot be seen any more: the caller must fall back.
 */
export class AnalyzerRestartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzerRestartedError';
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => {
      if (!d.settled) {
        d.settled = true;
        resolve(value);
      }
    },
    reject: (error) => {
      if (!d.settled) {
        d.settled = true;
        reject(error);
      }
    },
  };
  return d;
}

/**
 * Starts the analyzer in server mode (`dotnet aftershock-analyzer.dll serve --solution ...`), speaks
 * JSON-RPC with it, and restarts it with backoff when it crashes. Free of the vscode module.
 */
export class AnalyzerHost {
  private process: ChildProcess | undefined;
  private connection: JsonRpcConnection | undefined;
  private ready = deferred<InitializeResult>();
  private stateValue: AnalyzerState = 'stopped';
  private stopping = false;
  private crashes = 0;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly stderrTail: string[] = [];
  private initializeResult: InitializeResult | undefined;
  private testProjectsValue: WorkspaceTestProject[] | undefined;
  private readonly backoff: number[];
  private readonly stableAfterMs: number;
  private generation = 0;
  private exitHandled = 0;
  /** Restarts (crashes and requested) so far, and the value it had at the last successful initialize. */
  private crashEpoch = 0;
  /** Undefined until the first successful load: before it there is no snapshot to lose. */
  private readyEpoch: number | undefined;

  /** State changes (for the status bar). */
  onState: (state: AnalyzerState, detail?: string) => void = () => undefined;
  /** `progress` notifications. */
  onProgress: (progress: ProgressNotification) => void = () => undefined;
  /** The workspace was (re)loaded: new list of test projects. */
  onWorkspace: (projects: WorkspaceTestProject[]) => void = () => undefined;

  constructor(
    private readonly launch: AnalyzerLaunch,
    private readonly logger: Logger,
    private readonly options: AnalyzerHostOptions = {},
  ) {
    this.backoff = options.backoffMs ?? [1000, 2000, 5000, 10000, 30000];
    this.stableAfterMs = options.stableAfterMs ?? 60000;
  }

  get state(): AnalyzerState {
    return this.stateValue;
  }

  get initializeInfo(): InitializeResult | undefined {
    return this.initializeResult;
  }

  /** Test projects of the loaded workspace (undefined until the first successful load). */
  get testProjects(): WorkspaceTestProject[] | undefined {
    return this.testProjectsValue;
  }

  start(): void {
    if (this.ready.settled) {
      this.ready = deferred<InitializeResult>();
    }
    this.stopping = false;
    this.crashes = 0;
    this.spawnServer();
  }

  /** Resolves once the solution is loaded; rejects when the analyzer cannot load it or gave up restarting. */
  whenReady(): Promise<InitializeResult> {
    return this.ready.promise;
  }

  async impact(files: readonly string[]): Promise<ImpactReport> {
    // Saved while the analyzer was down after a crash: the restarted process loads these files with
    // their new content as its snapshot, so the change itself is invisible to it.
    const savedWhileDown = this.readyEpoch !== undefined && this.crashEpoch !== this.readyEpoch;
    await this.whenReady();
    const connection = this.connection;
    if (!connection) {
      throw new AnalyzerUnavailableError('the analyzer is not running');
    }
    const report = await connection.request<ImpactReport>('impact', { files }).result;
    if (savedWhileDown) {
      throw new AnalyzerRestartedError('the analyzer restarted after a crash; changes saved meanwhile cannot be analyzed');
    }
    return report;
  }

  /**
   * Base mode (`impactSinceBase`): the tests of the files' changes against `base` (the merge base of HEAD
   * and `base` unless `mergeBase` is false). Never supersedes other requests: the coverage asks for
   * different files in overlapping requests.
   */
  async impactSinceBase(base: string, files: readonly string[], options: { mergeBase?: boolean } = {}): Promise<ImpactReport> {
    await this.whenReady();
    const connection = this.connection;
    if (!connection) {
      throw new AnalyzerUnavailableError('the analyzer is not running');
    }
    if (this.initializeResult && this.initializeResult.capabilities?.impactSinceBase === false) {
      throw new AnalyzerUnavailableError('the analyzer cannot compare with a git base here (the solution is not in a git work tree)');
    }
    return connection.request<ImpactReport>('impactSinceBase', { base, files, mergeBase: options.mergeBase ?? true, supersede: false }).result;
  }

  async reload(): Promise<ReloadResult> {
    await this.whenReady();
    const connection = this.connection;
    if (!connection) {
      throw new AnalyzerUnavailableError('the analyzer is not running');
    }
    return connection.request<ReloadResult>('reload').result;
  }

  async status(): Promise<unknown> {
    const connection = this.connection;
    if (!connection) {
      throw new AnalyzerUnavailableError('the analyzer is not running');
    }
    return connection.request<unknown>('status').result;
  }

  /** Graceful stop: `shutdown`, `exit`, then a forced tree kill if the process lingers. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.ready.reject(new AnalyzerUnavailableError('the analyzer was stopped'));
    const child = this.process;
    const connection = this.connection;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.setState('stopped');
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      if (connection) {
        await Promise.race([connection.request('shutdown').result.catch(() => undefined), delay(3000)]);
        connection.notify('exit');
      }
      child.stdin?.end();
    } catch {
      // The process may already be gone.
    }
    const gone = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
    if (!gone && child.pid !== undefined) {
      this.logger.warn('The analyzer did not stop in time; killing it.');
      await killProcessTree(child.pid);
      await Promise.race([exited, delay(3000)]);
    }
    this.setState('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    // Like after a crash, files saved before the new process is ready cannot be analyzed.
    this.crashEpoch++;
    this.start();
  }

  // ---------------------------------------------------------------------------------------------

  private setState(state: AnalyzerState, detail?: string): void {
    this.stateValue = state;
    this.onState(state, detail);
  }

  private spawnServer(): void {
    const generation = ++this.generation;
    const { dotnetPath, analyzerDll, solution } = this.launch;
    const args = [analyzerDll, 'serve', '--solution', solution];
    const cwd = path.dirname(solution);
    this.setState('starting');
    this.logger.info(`Starting the analyzer: ${formatCommand(dotnetPath, args)}`);
    this.stderrTail.length = 0;
    this.startedAt = Date.now();

    let child: ChildProcess;
    try {
      child = this.options.spawnProcess
        ? this.options.spawnProcess(dotnetPath, args, cwd)
        : spawn(dotnetPath, args, {
            cwd,
            env: dotnetEnvironment(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
          });
    } catch (error) {
      this.handleExit(generation, null, null, error as Error);
      return;
    }
    this.process = child;

    const connection = new JsonRpcConnection(
      (line) => {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(line);
        }
      },
      (message) => this.logger.warn(`[analyzer] protocol: ${message}`),
    );
    this.connection = connection;
    connection.onNotification((method, params) => this.handleNotification(method, params));

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => connection.receive(data));
    child.stderr?.setEncoding('utf8');
    let stderrBuffer = '';
    child.stderr?.on('data', (data: string) => {
      stderrBuffer += data;
      let newline = stderrBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stderrBuffer.slice(0, newline).replace(/\r$/, '');
        stderrBuffer = stderrBuffer.slice(newline + 1);
        this.stderrTail.push(line);
        if (this.stderrTail.length > 60) {
          this.stderrTail.shift();
        }
        // stderr repeats the `log` notifications; keep it at trace level.
        this.logger.trace(`[analyzer stderr] ${line}`);
        newline = stderrBuffer.indexOf('\n');
      }
    });
    child.stdin?.on('error', () => undefined);
    child.once('error', (error) => this.handleExit(generation, null, null, error));
    child.once('exit', (code, signal) => this.handleExit(generation, code, signal));

    this.setState('loading');
    const initParams = {
      logLevel: 'info',
      options: {
        ...(this.launch.options.maxSymbols !== undefined ? { maxSymbols: this.launch.options.maxSymbols } : {}),
        ...(this.launch.options.fallbackGlobs !== undefined ? { fallbackGlobs: this.launch.options.fallbackGlobs } : {}),
      },
    };
    connection
      .request<InitializeResult>('initialize', initParams)
      .result.then((result) => {
        if (generation !== this.generation) {
          return;
        }
        this.initializeResult = result;
        this.readyEpoch = this.crashEpoch;
        this.testProjectsValue = result.workspace?.testProjects ?? [];
        if (result.protocolVersion !== 1) {
          this.logger.warn(`The analyzer speaks protocol version ${result.protocolVersion}; this extension expects 1.`);
        }
        this.logger.info(
          `Analyzer ${result.tool?.version ?? '?'} ready: ${result.workspace.projects} projects, ${result.workspace.documents} documents, ` +
            `${this.testProjectsValue.length} test projects; load ${formatDuration(result.workspace.loadMs)} (MSBuild: ${result.msbuild}).`,
        );
        for (const diagnostic of result.diagnostics ?? []) {
          const line = `[analyzer ${diagnostic.source}] ${diagnostic.message}`;
          if (diagnostic.severity === 'error') {
            this.logger.error(line);
          } else {
            this.logger.warn(line);
          }
        }
        this.setState('ready');
        this.onWorkspace(this.testProjectsValue);
        this.ready.resolve(result);
      })
      .catch((error: Error) => {
        if (generation !== this.generation || error instanceof ConnectionClosedError) {
          return; // handled by handleExit
        }
        const message = error instanceof RpcError ? error.message : String(error);
        this.logger.error(`The analyzer could not load ${solution}: ${message}`);
        this.setState('failed', message);
        this.ready.reject(new AnalyzerUnavailableError(message));
      });
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'log': {
        const log = params as LogNotification;
        const line = `[analyzer] ${log.message}`;
        if (log.level === 'error') {
          this.logger.error(line);
        } else if (log.level === 'warning') {
          this.logger.warn(line);
        } else if (log.level === 'debug') {
          this.logger.debug(line);
        } else {
          this.logger.info(line);
        }
        break;
      }
      case 'progress':
        this.onProgress(params as ProgressNotification);
        break;
      case 'workspaceReloaded': {
        const result = params as ReloadResult;
        if (result.success && result.workspace) {
          this.testProjectsValue = result.workspace.testProjects ?? this.testProjectsValue;
          this.logger.info(`Analyzer reloaded the workspace (${result.reason ?? 'reload'}) in ${formatDuration(result.durationMs ?? 0)}.`);
          this.onWorkspace(this.testProjectsValue ?? []);
        } else {
          this.logger.warn(`Analyzer workspace reload failed: ${result.error ?? 'unknown error'}`);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleExit(generation: number, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (generation !== this.generation || this.exitHandled === generation) {
      return;
    }
    this.exitHandled = generation;
    const connection = this.connection;
    this.connection = undefined;
    this.process = undefined;
    const description = error ? error.message : `exit code ${code ?? signal}`;
    connection?.close(new ConnectionClosedError(`the analyzer stopped (${description})`));
    if (this.stopping) {
      return;
    }

    this.crashEpoch++;
    this.logger.error(`The analyzer stopped unexpectedly (${description}).`);
    if (this.stderrTail.length > 0) {
      this.logger.error('Last analyzer output:');
      this.stderrTail.forEach((line) => this.logger.error(`  ${line}`));
    }

    const lived = Date.now() - this.startedAt;
    this.crashes = lived >= this.stableAfterMs ? 1 : this.crashes + 1;
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      this.setState('failed', `"${this.launch.dotnetPath}" was not found`);
      this.ready.reject(new AnalyzerUnavailableError(`"${this.launch.dotnetPath}" was not found. Check aftershock.dotnetPath.`));
      return;
    }
    if (this.crashes > this.backoff.length) {
      const message = `the analyzer crashed ${this.crashes} times in a row; not restarting it (use "Aftershock: Restart Analyzer")`;
      this.logger.error(message);
      this.setState('failed', message);
      this.ready.reject(new AnalyzerUnavailableError(message));
      return;
    }
    const wait = this.backoff[this.crashes - 1];
    if (this.ready.settled) {
      // Requests that arrive while restarting wait for the new process.
      this.ready = deferred<InitializeResult>();
    }
    this.logger.info(`Restarting the analyzer in ${formatDuration(wait)} (attempt ${this.crashes}).`);
    this.setState('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.stopping) {
        this.spawnServer();
      }
    }, wait);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
