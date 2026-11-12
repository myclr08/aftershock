import * as vscode from 'vscode';
import type { AnalyzerState } from '../core/analyzerHost';
import { formatDuration } from '../core/logger';
import type { OrchestratorStatus } from '../core/orchestrator';

export interface StatusView {
  analyzer: AnalyzerState | 'noSolution';
  analyzerDetail?: string;
  run: OrchestratorStatus;
  solution?: string;
}

interface Presentation {
  text: string;
  background?: 'error' | 'warning';
}

/** The status bar item: current step or last result; click opens the output channel. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem('aftershock.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Aftershock';
    this.item.command = command;
    this.item.text = '$(beaker) Aftershock';
    this.item.show();
  }

  update(view: StatusView): void {
    const presentation = present(view);
    this.item.text = presentation.text;
    this.item.backgroundColor = presentation.background ? new vscode.ThemeColor(`statusBarItem.${presentation.background}Background`) : undefined;
    this.item.tooltip = tooltip(view);
  }

  dispose(): void {
    this.item.dispose();
  }
}

function present(view: StatusView): Presentation {
  const run = view.run;
  switch (run.phase) {
    case 'analyzing':
      if (view.analyzer === 'starting' || view.analyzer === 'loading' || view.analyzer === 'restarting') {
        return { text: `$(loading~spin) ${vscode.l10n.t('Loading solution…')}` };
      }
      return { text: `$(loading~spin) ${vscode.l10n.t('Analyzing…')}` };
    case 'restoring':
      return { text: `$(loading~spin) ${vscode.l10n.t('Restoring…')}` };
    case 'building':
      return { text: `$(loading~spin) ${vscode.l10n.t('Building…')}` };
    case 'testing':
      return { text: `$(loading~spin) ${run.tests !== undefined ? vscode.l10n.t('Testing ({0})…', run.tests) : vscode.l10n.t('Testing…')}` };
    case 'waitingForDebug':
      return { text: `$(debug-pause) ${vscode.l10n.t('Waiting for debug session')}`, background: 'warning' };
    case 'paused':
      return { text: `$(debug-pause) ${vscode.l10n.t('Aftershock paused')}` };
    case 'error':
      return { text: `$(warning) ${vscode.l10n.t('Aftershock error')}`, background: 'error' };
    default:
      break;
  }

  if (view.analyzer === 'noSolution') {
    return { text: `$(beaker) ${vscode.l10n.t('Aftershock: no solution')}` };
  }
  if (view.analyzer === 'failed') {
    return { text: `$(warning) ${vscode.l10n.t('Analyzer failed')}`, background: 'error' };
  }

  const summary = run.summary;
  if (run.phase === 'done' && summary) {
    if (summary.failed > 0) {
      return { text: `$(error) ${vscode.l10n.t('{0} failed', summary.failed)}`, background: 'error' };
    }
    if (summary.buildFailed.length > 0) {
      return { text: `$(error) ${vscode.l10n.t('Build failed')}`, background: 'error' };
    }
    if (summary.runFailed.length > 0) {
      return { text: `$(warning) ${vscode.l10n.t('Test run failed')}`, background: 'warning' };
    }
    if (summary.noTests) {
      return { text: `$(check) ${vscode.l10n.t('No impacted tests')}` };
    }
    return { text: `$(check) ${summary.passed}/${summary.total}` };
  }

  if (view.analyzer === 'starting' || view.analyzer === 'loading') {
    return { text: `$(loading~spin) ${vscode.l10n.t('Loading solution…')}` };
  }
  if (view.analyzer === 'restarting') {
    return { text: `$(loading~spin) ${vscode.l10n.t('Restarting analyzer…')}`, background: 'warning' };
  }
  return { text: '$(beaker) Aftershock' };
}

function tooltip(view: StatusView): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.appendMarkdown(`**Aftershock**\n\n`);
  const summary = view.run.summary;
  if (summary && !summary.noTests) {
    md.appendMarkdown(
      `${vscode.l10n.t('Last run: {0} passed, {1} failed, {2} skipped in {3} (save to result).', summary.passed, summary.failed, summary.skipped, formatDuration(summary.durationMs))}\n\n`,
    );
    if (summary.buildFailed.length > 0) {
      md.appendMarkdown(`${vscode.l10n.t('Build failed: {0}', summary.buildFailed.join(', '))}\n\n`);
    }
    if (summary.runFailed.length > 0) {
      md.appendMarkdown(`${vscode.l10n.t('Could not run: {0}', summary.runFailed.join(', '))}\n\n`);
    }
  } else if (summary?.noTests) {
    md.appendMarkdown(`${vscode.l10n.t('The last save reached no tests.')}\n\n`);
  }
  if (view.run.fallbackReasons.length > 0) {
    md.appendMarkdown(`${vscode.l10n.t('Whole test projects run because:')}\n\n`);
    for (const reason of view.run.fallbackReasons.slice(0, 8)) {
      md.appendMarkdown(`- ${escapeMarkdown(reason)}\n`);
    }
    md.appendMarkdown('\n');
  }
  if (view.run.phase === 'error' && view.run.message) {
    md.appendMarkdown(`${escapeMarkdown(view.run.message)}\n\n`);
  }
  if (view.analyzer === 'failed' && view.analyzerDetail) {
    md.appendMarkdown(`${vscode.l10n.t('Analyzer: {0}', escapeMarkdown(view.analyzerDetail))}\n\n`);
  }
  if (view.solution) {
    md.appendMarkdown(`${vscode.l10n.t('Solution: {0}', escapeMarkdown(view.solution))}\n\n`);
  }
  md.appendMarkdown(vscode.l10n.t('Click to show the output.'));
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
}
