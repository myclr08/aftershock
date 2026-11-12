// Runs inside the VS Code extension host (see runTest.mjs). Plain assertions, no test framework.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AftershockApi } from '../../src/extension';

const workspace = process.env.AFTERSHOCK_IT_WORKSPACE!;
const file = (relative: string) => path.join(workspace, ...relative.split('/'));

async function until<T>(what: string, probe: () => T | undefined | false, timeoutMs = 180000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function editAndSave(relative: string, from: string, to: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(file(relative));
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const offset = text.indexOf(from);
  assert.ok(offset >= 0, `${relative} contains ${from}`);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + from.length)), to);
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(await document.save());
  return uri;
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  await body();
  console.log(`  ok ${name} (${Date.now() - started} ms)`);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<AftershockApi>('aftershock-dev.aftershock');
  assert.ok(extension, 'extension installed');
  const api = await extension.activate();

  await step('commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['aftershock.runAllTests', 'aftershock.showImpactedTests', 'aftershock.togglePause', 'aftershock.restartAnalyzer', 'aftershock.showOutput']) {
      assert.ok(commands.includes(id), id);
    }
  });

  await step('the analyzer loads the sample solution', async () => {
    const analyzer = await until('analyzer', () => api.analyzer);
    const init = await analyzer.whenReady();
    assert.strictEqual(path.basename(init.solution), 'ImpactSample.sln');
    assert.strictEqual(init.workspace.testProjects.length, 4);
  });

  const orchestrator = api.orchestrator!;
  let runs = 0;
  orchestrator.onRunCompleted(() => runs++);
  const saveAndWait = async (relative: string, from: string, to: string) => {
    const before = runs;
    const uri = await editAndSave(relative, from, to);
    await until('the run to finish', () => runs > before && !orchestrator.isBusy);
    return uri;
  };

  await step('saving TaxRates.cs runs the 5 impacted xUnit tests', async () => {
    await saveAndWait('src/Sample.Core/Pricing/TaxRates.cs', '"NL" => 0.21m,', '"NL" => 0.215m,');
    assert.deepStrictEqual(
      { passed: orchestrator.status.summary?.passed, failed: orchestrator.status.summary?.failed, total: orchestrator.status.summary?.total },
      { passed: 5, failed: 0, total: 5 },
    );
    assert.strictEqual(orchestrator.lastSelection.filter((e) => e.test).length, 5);
  });

  const testFile = 'tests/Sample.Tests.XUnit/TaxRatesTests.cs';
  await step('a failing test shows up in the Problems panel at its declaration', async () => {
    const uri = await saveAndWait(testFile, '[InlineData("TR", 0.20)]', '[InlineData("TR", 0.25)]');
    const diagnostics = await until('a diagnostic', () => {
      const found = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Aftershock');
      return found.length > 0 ? found : undefined;
    });
    const declaration = fs.readFileSync(file(testFile), 'utf8').split(/\r?\n/).findIndex((line) => line.includes('void ForCountry_ReturnsRate('));
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].range.start.line, declaration);
    assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    assert.match(diagnostics[0].message, /Assert\.Equal\(\) Failure/);
  });

  await step('fixing the test clears the diagnostic', async () => {
    const uri = await saveAndWait(testFile, '[InlineData("TR", 0.25)]', '[InlineData("TR", 0.20)]');
    await until('no diagnostics', () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Aftershock').length === 0);
    assert.strictEqual(orchestrator.failed.size, 0);
  });

  await step('pause and resume', async () => {
    await vscode.commands.executeCommand('aftershock.togglePause');
    assert.strictEqual(orchestrator.isPaused, true);
    await vscode.commands.executeCommand('aftershock.togglePause');
    assert.strictEqual(orchestrator.isPaused, false);
    await vscode.commands.executeCommand('aftershock.showOutput');
  });
}
