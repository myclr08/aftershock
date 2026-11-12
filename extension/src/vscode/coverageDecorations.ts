import * as vscode from 'vscode';
import type { FileCoverageView } from '../core/coverage';
import { pathKey } from '../core/paths';

export interface AppliedDecorations {
  /** 1-based line numbers. */
  uncovered: number[];
  partial: number[];
}

/**
 * Editor decorations for new lines only (DESIGN.md 9): uncovered lines red, lines that miss some of
 * their conditions yellow, as a gutter mark plus a light whole-line background (theme colors from
 * `contributes.colors`). Documents with unsaved changes keep their current decorations (VS Code moves
 * them with the edits) until they are saved and measured again.
 */
export class CoverageDecorations implements vscode.Disposable {
  private readonly uncovered: vscode.TextEditorDecorationType;
  private readonly partial: vscode.TextEditorDecorationType;
  /** What was applied per file (integration tests). */
  readonly applied = new Map<string, AppliedDecorations>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly source: () => ((file: string) => FileCoverageView | undefined) | undefined,
    private readonly enabled: () => boolean,
  ) {
    const icon = (name: string) => vscode.Uri.joinPath(extensionUri, 'media', `coverage-${name}.svg`);
    this.uncovered = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('aftershock.uncoveredLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('aftershock.uncoveredLineRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconSize: 'contain',
      light: { gutterIconPath: icon('uncovered-light') },
      dark: { gutterIconPath: icon('uncovered-dark') },
    });
    this.partial = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('aftershock.partialLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('aftershock.partialLineRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconSize: 'contain',
      light: { gutterIconPath: icon('partial-light') },
      dark: { gutterIconPath: icon('partial-dark') },
    });
  }

  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  apply(editor: vscode.TextEditor): void {
    const document = editor.document;
    if (document.uri.scheme !== 'file') {
      return;
    }
    const file = document.uri.fsPath;
    const key = pathKey(file);
    const view = this.enabled() ? this.source()?.(file) : undefined;
    if (view && document.isDirty) {
      return;
    }
    const lineCount = document.lineCount;
    const range = (line: number) => new vscode.Range(line - 1, 0, line - 1, 0);
    const inDocument = (line: number) => line >= 1 && line <= lineCount;
    const note = view && !view.complete ? `\n\n${vscode.l10n.t('Measured by partial runs only; save the file or recompute for complete numbers.')}` : '';

    const uncovered = (view?.metrics.uncoveredLines ?? []).filter(inDocument);
    const partial = (view?.metrics.partialLines ?? []).filter((p) => inDocument(p.line));
    editor.setDecorations(
      this.uncovered,
      uncovered.map((line) => ({ range: range(line), hoverMessage: hover(vscode.l10n.t('New line not covered by any test.') + note) })),
    );
    editor.setDecorations(
      this.partial,
      partial.map((p) => ({
        range: range(p.line),
        hoverMessage: hover(vscode.l10n.t('New line: {0} of {1} conditions covered ({2} hits).', p.covered, p.total, p.hits) + note),
      })),
    );
    if (uncovered.length === 0 && partial.length === 0) {
      this.applied.delete(key);
    } else {
      this.applied.set(key, { uncovered, partial: partial.map((p) => p.line) });
    }
  }

  clear(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.uncovered, []);
      editor.setDecorations(this.partial, []);
    }
    this.applied.clear();
  }

  dispose(): void {
    this.uncovered.dispose();
    this.partial.dispose();
    this.applied.clear();
  }
}

function hover(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown('**Aftershock** · ');
  md.appendText(text);
  return md;
}
