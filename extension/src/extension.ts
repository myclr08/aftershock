import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveAnalyzerDll } from './core/analyzerLocation';
import { AnalyzerHost, type AnalyzerState } from './core/analyzerHost';
import { CoverageManager, type CoverageSettings } from './core/coverage';
import type { CoverageTool } from './core/coverageCollection';
import { PlanExecutor } from './core/executor';
import type { Logger } from './core/logger';
import { runGit } from './core/newCode';
import { Orchestrator } from './core/orchestrator';
import { pathKey } from './core/paths';
import { discoverSolution } from './core/solution';
import { simpleClassName } from './core/testLocator';
import type { StateStore } from './core/work';
import { CoverageDecorations, type AppliedDecorations } from './vscode/coverageDecorations';
import { FailedTestDiagnostics } from './vscode/diagnostics';
import { StatusBar } from './vscode/statusBar';

const SECTION = 'aftershock';
/** Saved files that can change the impact (DESIGN.md 4.2), plus solution files (the analyzer reloads on them). */
const WATCHED_EXTENSIONS = new Set(['.cs', '.csproj', '.props', '.targets', '.json', '.sln', '.slnx']);
/** Changing one of these restarts the analyzer. */
const RESTART_SETTINGS = ['solution', 'dotnetPath', 'maxImpactedSymbols', 'fallbackGlobs'];
/** Coverage settings: changing one recomputes the new code and the display. */
const COVERAGE_SETTINGS = ['targetBranch', 'coverageThreshold', 'coverageEnabled', 'coverageTool', 'coverageExclusions', 'coverageDecorations'];

interface Settings {
  solution: string;
  debounceMs: number;
  maxImpactedSymbols: number;
  fallbackGlobs: string[];
  testFilter: string;
  disableAnalyzersInBuild: boolean;
  dotnetPath: string;
  targetBranch: string;
  coverageThreshold: number;
  coverageEnabled: boolean;
  coverageTool: CoverageTool;
  coverageExclusions: string[];
  coverageDecorations: boolean;
}

function readSettings(scope?: vscode.Uri): Settings {
  const config = vscode.workspace.getConfiguration(SECTION, scope);
  const threshold = Number(config.get<number>('coverageThreshold', 85));
  return {
    solution: config.get<string>('solution', ''),
    debounceMs: config.get<number>('debounceMs', 1500),
    maxImpactedSymbols: config.get<number>('maxImpactedSymbols', 500),
    fallbackGlobs: config.get<string[]>('fallbackGlobs', ['**/appsettings*.json']),
    testFilter: config.get<string>('testFilter', ''),
    disableAnalyzersInBuild: config.get<boolean>('disableAnalyzersInBuild', true),
    dotnetPath: config.get<string>('dotnetPath', 'dotnet').trim() || 'dotnet',
    targetBranch: config.get<string>('targetBranch', '').trim(),
    coverageThreshold: Number.isFinite(threshold) ? Math.min(100, Math.max(0, threshold)) : 85,
    coverageEnabled: config.get<boolean>('coverageEnabled', true),
    coverageTool: config.get<string>('coverageTool', 'coverlet') === 'microsoft' ? 'microsoft' : 'coverlet',
    coverageExclusions: (config.get<string[]>('coverageExclusions', []) ?? []).filter((p) => typeof p === 'string' && p.trim()),
    coverageDecorations: config.get<boolean>('coverageDecorations', true),
  };
}

function channelLogger(channel: vscode.LogOutputChannel): Logger {
  return {
    trace: (m) => channel.trace(m),
    debug: (m) => channel.debug(m),
    info: (m) => channel.info(m),
    warn: (m) => channel.warn(m),
    error: (m) => channel.error(m),
  };
}

/** workspaceState with keys scoped to one solution. */
function scopedState(memento: vscode.Memento, solution: string): StateStore {
  const prefix = `${pathKey(solution)}|`;
  return {
    get: <T>(key: string) => memento.get<T>(prefix + key),
    update: (key, value) => memento.update(prefix + key, value),
  };
}

interface Session {
  workspaceFolder: vscode.WorkspaceFolder;
  solution: string;
  analyzer: AnalyzerHost;
  executor: PlanExecutor;
  orchestrator: Orchestrator;
  coverage: CoverageManager;
  disposables: vscode.Disposable[];
}

class AftershockController implements vscode.Disposable {
  private session: Session | undefined;
  private analyzerState: AnalyzerState | 'noSolution' = 'stopped';
  private analyzerDetail: string | undefined;
  private readonly debugSessions = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly logger: Logger;
  private paused = false;
  private restarting: Promise<void> | undefined;

  readonly decorations: CoverageDecorations;
  private lastFocusRefresh = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    channel: vscode.LogOutputChannel,
    private readonly statusBar: StatusBar,
    private readonly diagnostics: FailedTestDiagnostics,
  ) {
    this.logger = channelLogger(channel);
    this.decorations = new CoverageDecorations(
      context.extensionUri,
      () => {
        const coverage = this.session?.coverage;
        return coverage ? (file: string) => coverage.fileView(file) : undefined;
      },
      () => {
        const folder = this.session?.workspaceFolder;
        const settings = readSettings(folder?.uri);
        return settings.coverageEnabled && settings.coverageDecorations;
      },
    );
    for (const session of [vscode.debug.activeDebugSession].filter((s): s is vscode.DebugSession => !!s)) {
      this.debugSessions.add(session.id);
    }
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => this.onSaved(document)),
      vscode.workspace.onDidChangeConfiguration((event) => this.onConfigurationChanged(event)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.restart('workspace folders changed')),
      vscode.debug.onDidStartDebugSession((session) => {
        this.debugSessions.add(session.id);
        this.session?.orchestrator.setGate('debug', true);
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.debugSessions.delete(session.id);
        if (this.debugSessions.size === 0 && !vscode.debug.activeDebugSession) {
          this.session?.orchestrator.setGate('debug', false);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorations.refresh()),
      vscode.window.onDidChangeWindowState((state) => {
        // Branch switches and commits made outside VS Code change the new code.
        if (state.focused && Date.now() - this.lastFocusRefresh > 2000) {
          this.lastFocusRefresh = Date.now();
          void this.session?.coverage.refreshNewCode();
        }
      }),
      this.decorations,
    );
  }

  get current(): Session | undefined {
    return this.session;
  }

  async start(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let choice: ReturnType<typeof discoverSolution> | undefined;
    let folder: vscode.WorkspaceFolder | undefined;
    for (const candidate of folders) {
      const settings = readSettings(candidate.uri);
      const found = discoverSolution(candidate.uri.fsPath, settings.solution);
      if (found.solution) {
        choice = found;
        folder = candidate;
        break;
      }
      choice ??= found;
    }
    if (!choice?.solution || !folder) {
      this.logger.warn(choice?.message ?? 'No workspace folder is open.');
      this.analyzerState = 'noSolution';
      this.render();
      return;
    }
    this.logger.info(choice.message);
    const solution = choice.solution;
    const settings = readSettings(folder.uri);

    const location = resolveAnalyzerDll(this.context.extensionPath);
    if (!location.dll) {
      this.logger.error(`The analyzer was not found. Looked for: ${location.tried.join(', ')}. Run "npm run bundle-analyzer" in the extension folder (development) or reinstall the extension.`);
      this.analyzerState = 'failed';
      this.analyzerDetail = vscode.l10n.t('The bundled analyzer is missing.');
      this.render();
      return;
    }

    const analyzer = new AnalyzerHost(
      {
        dotnetPath: settings.dotnetPath,
        analyzerDll: location.dll,
        solution,
        options: { maxSymbols: settings.maxImpactedSymbols, fallbackGlobs: settings.fallbackGlobs },
      },
      this.logger,
    );
    const state = scopedState(this.context.workspaceState, solution);
    const storage = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
    const solutionId = createHash('sha1').update(pathKey(solution)).digest('hex').slice(0, 16);
    const coverage = new CoverageManager({
      solutionDirectory: path.dirname(solution),
      storeFile: path.join(storage, 'coverage', `${solutionId}.json`),
      analyzer,
      logger: this.logger,
      settings: (): CoverageSettings => {
        const current = readSettings(folder!.uri);
        return { enabled: current.coverageEnabled, tool: current.coverageTool, targetBranch: current.targetBranch };
      },
      // M5a: the server's gate threshold and exclusions take part here.
      policy: () => {
        const current = readSettings(folder!.uri);
        return { thresholdPercent: current.coverageThreshold, thresholdSource: 'setting', exclusions: current.coverageExclusions };
      },
    });
    const executor = new PlanExecutor({
      solutionDirectory: path.dirname(solution),
      resultsRoot: path.join(storage, 'results'),
      state,
      logger: this.logger,
      settings: () => {
        const current = readSettings(folder!.uri);
        return { dotnetPath: current.dotnetPath, testFilter: current.testFilter, disableAnalyzersInBuild: current.disableAnalyzersInBuild };
      },
      hooks: [coverage],
    });
    const orchestrator = new Orchestrator({
      analyzer,
      executor,
      state,
      logger: this.logger,
      debounceMs: () => readSettings(folder!.uri).debounceMs,
      coverage,
    });

    analyzer.onState = (analyzerState, detail) => {
      this.analyzerState = analyzerState;
      this.analyzerDetail = detail;
      this.render();
    };
    analyzer.onWorkspace = () => {
      // Test projects are known now (they are not new code).
      void coverage.refreshNewCode();
    };
    orchestrator.onStatus(() => this.render());
    orchestrator.onRunCompleted(() => this.diagnostics.update(orchestrator.failed.all()));
    coverage.onDidChange(() => {
      this.render();
      this.decorations.refresh();
    });
    if (this.debugSessions.size > 0) {
      orchestrator.setGate('debug', true);
    }
    if (this.paused) {
      orchestrator.setGate('paused', true);
    }

    const session: Session = { workspaceFolder: folder, solution, analyzer, executor, orchestrator, coverage, disposables: [] };
    this.session = session;
    void this.watchGit(path.dirname(solution), () => void coverage.refreshNewCode()).then((watcher) => {
      if (this.session === session) {
        session.disposables.push(watcher);
      } else {
        watcher.dispose();
      }
    });
    this.diagnostics.update(orchestrator.failed.all());
    analyzer.start();
    void coverage.refreshNewCode();
    this.render();
  }

  /** Watches HEAD and the refs, so a branch switch, commit, fetch or rebase recomputes the new code. */
  private async watchGit(directory: string, onChange: () => void): Promise<vscode.Disposable> {
    const directories = new Set<string>();
    for (const args of [['rev-parse', '--absolute-git-dir'], ['rev-parse', '--git-common-dir']]) {
      const result = await runGit(args, directory);
      const value = result.code === 0 ? result.stdout.toString('utf8').trim() : '';
      if (value) {
        directories.add(path.resolve(directory, value));
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const fire = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        onChange();
      }, 750);
    };
    const watchers = [...directories].map((dir) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,packed-refs,refs/**}'));
      watcher.onDidChange(fire);
      watcher.onDidCreate(fire);
      watcher.onDidDelete(fire);
      return watcher;
    });
    return new vscode.Disposable(() => {
      if (timer) {
        clearTimeout(timer);
      }
      watchers.forEach((w) => w.dispose());
    });
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) {
      session.disposables.forEach((d) => d.dispose());
      // Kill a running build/test (bounded), then stop the analyzer.
      await Promise.race([session.orchestrator.dispose(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      await session.analyzer.stop();
      this.decorations.clear();
    }
  }

  restart(reason: string): Promise<void> {
    this.restarting ??= (async () => {
      this.logger.info(`Restarting (${reason}).`);
      await this.stop();
      await this.start();
    })().finally(() => {
      this.restarting = undefined;
    });
    return this.restarting;
  }

  async restartAnalyzer(): Promise<void> {
    if (!this.session) {
      await this.restart('requested');
      return;
    }
    this.logger.info('Restarting the analyzer (requested).');
    await this.session.analyzer.restart();
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.session?.orchestrator.setGate('paused', this.paused);
    this.logger.info(this.paused ? 'Paused: saves are analyzed, but nothing is built or run until you resume.' : 'Resumed.');
    void vscode.window.setStatusBarMessage(this.paused ? vscode.l10n.t('Aftershock paused') : vscode.l10n.t('Aftershock resumed'), 3000);
    this.render();
  }

  async runAll(): Promise<void> {
    if (!this.session) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Aftershock has no solution to run tests for.'));
      return;
    }
    if (this.paused) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Aftershock is paused; the tests run when you resume.'));
    }
    await this.session.orchestrator.runAll();
  }

  async recomputeCoverage(): Promise<void> {
    const session = this.session;
    if (!session) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Aftershock has no solution to compute coverage for.'));
      return;
    }
    if (!readSettings(session.workspaceFolder.uri).coverageEnabled) {
      void vscode.window.showInformationMessage(vscode.l10n.t('New-code coverage is turned off (aftershock.coverageEnabled).'));
      return;
    }
    if (this.paused) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Aftershock is paused; the tests run when you resume.'));
    }
    const added = await session.orchestrator.enqueue('Recompute new-code coverage', () => session.coverage.recomputeAll(), { showAnalyzing: true });
    if (!added) {
      const summary = session.coverage.summary();
      if (summary.state === 'error') {
        void vscode.window.showWarningMessage(vscode.l10n.t('New-code coverage is unknown: {0}', summary.error ?? ''));
      } else if (summary.state === 'noNewCode') {
        void vscode.window.showInformationMessage(vscode.l10n.t('No C# code outside test projects changed against {0}.', summary.target ?? ''));
      } else {
        void vscode.window.showInformationMessage(vscode.l10n.t('No test reaches the new code; there is nothing to run.'));
      }
    }
  }

  async showImpactedTests(): Promise<void> {
    const selection = this.session?.orchestrator.lastSelection ?? [];
    if (selection.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No tests have been selected yet. Save a C# file to start.'));
      return;
    }
    type Item = vscode.QuickPickItem & { file?: string; line?: number };
    const items: Item[] = selection.map((entry): Item => {
      if (!entry.test) {
        return {
          label: `$(list-flat) ${vscode.l10n.t('{0}: all tests', entry.projectName)}`,
          detail: entry.reasons.join(' · ') || undefined,
        };
      }
      const test = entry.test;
      const icon = entry.outcome === 'passed' ? '$(pass)' : entry.outcome === 'failed' ? '$(error)' : entry.outcome === 'skipped' ? '$(circle-slash)' : '$(circle-outline)';
      const why =
        test.origin === 'previouslyFailed'
          ? vscode.l10n.t('failed in an earlier run; re-run until it passes')
          : test.chain.length > 0
            ? test.chain.join(' ← ')
            : test.reason;
      return {
        label: `${icon} ${simpleClassName(test.className)}.${test.methodName}`,
        description: entry.mode === 'all' ? vscode.l10n.t('{0} (whole project)', entry.projectName) : entry.projectName,
        detail: `${test.reason}: ${why}`,
        file: test.file,
        line: test.line,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Impacted tests of the last run'),
      placeHolder: vscode.l10n.t('Select a test to open it'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked?.file) {
      const line = Math.max(0, (picked.line ?? 1) - 1);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.file));
      await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, line, 0) });
    }
  }

  private onSaved(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const file = document.uri.fsPath;
    const extension = path.extname(file).toLowerCase();
    if (!WATCHED_EXTENSIONS.has(extension) || /[\\/](bin|obj)[\\/]/i.test(file)) {
      return;
    }
    const session = this.session;
    if (!session) {
      if (extension === '.sln' || extension === '.slnx') {
        void this.restart('a solution file was saved');
      }
      return;
    }
    if (this.analyzerState === 'failed' && ['.csproj', '.props', '.targets', '.sln', '.slnx', '.json'].includes(extension)) {
      // A fixed project file is the usual way out of a load failure.
      this.logger.info(`${path.basename(file)} was saved while the analyzer is not loaded; restarting it.`);
      void session.analyzer.restart();
    }
    session.orchestrator.onSaved([file]);
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (RESTART_SETTINGS.some((name) => event.affectsConfiguration(`${SECTION}.${name}`))) {
      void this.restart('settings changed');
      return;
    }
    if (event.affectsConfiguration(`${SECTION}.disableAnalyzersInBuild`) || event.affectsConfiguration(`${SECTION}.testFilter`)) {
      this.session?.executor.invalidate();
    }
    if (COVERAGE_SETTINGS.some((name) => event.affectsConfiguration(`${SECTION}.${name}`))) {
      if (event.affectsConfiguration(`${SECTION}.coverageTool`)) {
        this.logger.info('The coverage tool changed: coverage measured with the other tool no longer counts. Run "Aftershock: Recompute New-Code Coverage".');
      }
      void this.session?.coverage.refreshNewCode().then(() => this.session?.coverage.logSummary());
      this.render();
      this.decorations.refresh();
    }
  }

  render(): void {
    this.statusBar.update({
      analyzer: this.analyzerState,
      analyzerDetail: this.analyzerDetail,
      run: this.session?.orchestrator.status ?? { phase: this.paused ? 'paused' : 'idle', fallbackReasons: [] },
      solution: this.session?.solution,
      coverage: this.session?.coverage.summary(),
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

let controller: AftershockController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<AftershockApi> {
  const channel = vscode.window.createOutputChannel('Aftershock', { log: true });
  const statusBar = new StatusBar('aftershock.showOutput');
  const diagnostics = new FailedTestDiagnostics();
  controller = new AftershockController(context, channel, statusBar, diagnostics);
  const current = controller;
  context.subscriptions.push(
    channel,
    statusBar,
    diagnostics,
    current,
    vscode.commands.registerCommand('aftershock.runAllTests', () => current.runAll()),
    vscode.commands.registerCommand('aftershock.showImpactedTests', () => current.showImpactedTests()),
    vscode.commands.registerCommand('aftershock.recomputeCoverage', () => current.recomputeCoverage()),
    vscode.commands.registerCommand('aftershock.togglePause', () => current.togglePause()),
    vscode.commands.registerCommand('aftershock.restartAnalyzer', () => current.restartAnalyzer()),
    vscode.commands.registerCommand('aftershock.showOutput', () => channel.show(true)),
  );
  await current.start();
  return {
    get orchestrator() {
      return current.current?.orchestrator;
    },
    get analyzer() {
      return current.current?.analyzer;
    },
    get coverage() {
      return current.current?.coverage;
    },
    statusText: () => statusBar.text,
    decorationsOf: (file: string) => current.decorations.applied.get(pathKey(file)),
  };
}

export async function deactivate(): Promise<void> {
  await controller?.stop();
  controller = undefined;
}

/** Returned from activate(); used by the integration tests. */
export interface AftershockApi {
  readonly orchestrator: Orchestrator | undefined;
  readonly analyzer: AnalyzerHost | undefined;
  readonly coverage: CoverageManager | undefined;
  /** The status bar text last shown. */
  statusText(): string;
  /** Coverage decorations last applied to a file's editor. */
  decorationsOf(file: string): AppliedDecorations | undefined;
}
