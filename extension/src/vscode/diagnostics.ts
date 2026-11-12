import * as fs from 'fs';
import * as vscode from 'vscode';
import { rangeOnLine, simpleClassName } from '../core/testLocator';
import type { FailedTest } from '../core/work';

const STACK_LINES = 5;

/** Problems panel entries for failed tests, rebuilt from the failed-test store after every run. */
export class FailedTestDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('aftershock');

  update(failed: readonly FailedTest[]): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const lineCache = new Map<string, string[]>();
    for (const test of failed) {
      if (!test.file || !test.line) {
        continue;
      }
      let lines = lineCache.get(test.file);
      if (!lines) {
        try {
          lines = fs.readFileSync(test.file, 'utf8').split(/\r?\n/);
        } catch {
          lines = [];
        }
        lineCache.set(test.file, lines);
      }
      const lineIndex = Math.max(0, test.line - 1);
      const columns = rangeOnLine(lines[lineIndex] ?? '', test.methodName);
      const range = new vscode.Range(lineIndex, columns.start, lineIndex, columns.end);
      const diagnostic = new vscode.Diagnostic(range, message(test), vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'Aftershock';
      diagnostic.code = test.fullyQualifiedName;
      const list = byFile.get(test.file) ?? [];
      list.push(diagnostic);
      byFile.set(test.file, list);
    }
    this.collection.clear();
    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(file), diagnostics);
    }
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function message(test: FailedTest): string {
  const name = `${simpleClassName(test.className)}.${test.methodName}`;
  const header =
    test.cases && test.cases > 1
      ? vscode.l10n.t('Test {0} failed ({1} of {2} cases).', name, test.failedCases ?? 1, test.cases)
      : vscode.l10n.t('Test {0} failed.', name);
  const parts = [header];
  if (test.cases && test.cases > 1 && test.failedCase) {
    parts.push(test.failedCase);
  }
  if (test.message) {
    parts.push(test.message.trim());
  }
  const stack = (test.stackTrace ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, STACK_LINES);
  if (stack.length > 0) {
    parts.push(stack.map((line) => line.trim()).join('\n'));
  }
  return parts.join('\n');
}
