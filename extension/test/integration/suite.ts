// Runs inside the VS Code extension host (see runTest.mjs). Plain assertions, no test framework.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
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
    for (const id of ['aftershock.runAllTests', 'aftershock.showImpactedTests', 'aftershock.recomputeCoverage', 'aftershock.togglePause', 'aftershock.restartAnalyzer', 'aftershock.showOutput']) {
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

  const discount = 'src/Sample.Core/Discounts/DiscountCalculator.cs';
  const lineOf = (relative: string, needle: string) => fs.readFileSync(file(relative), 'utf8').split(/\r?\n/).findIndex((line) => line.includes(needle)) + 1;

  await step('new code with one tested path: decorations on the uncovered and the partly covered line, coverage in the status bar', async () => {
    const coverage = api.coverage!;
    const before = runs;
    // A new method with a branch, and a new test for one of its paths, saved together.
    const discountUri = vscode.Uri.file(file(discount));
    const document = await vscode.workspace.openTextDocument(discountUri);
    const text = document.getText();
    const brace = text.lastIndexOf('}');
    const method = ['', '    public static decimal ApplyLoyalty(decimal amount, bool isMember)', '    {', '        if (isMember)', '        {', '            return amount - 1m;', '        }', '', '        return amount;', '    }', ''].join('\n');
    const testUri = vscode.Uri.file(file('tests/Sample.Tests.XUnit/LoyaltyDiscountTests.cs'));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(discountUri, document.positionAt(brace), method);
    edit.createFile(testUri, { ignoreIfExists: true });
    edit.insert(
      testUri,
      new vscode.Position(0, 0),
      ['using Sample.Core.Discounts;', '', 'namespace Sample.Tests.XUnit;', '', 'public class LoyaltyDiscountTests', '{', '    [Fact]', '    public void Member_GetsOneOff()', '    {', '        Assert.Equal(9m, DiscountCalculator.ApplyLoyalty(10m, true));', '    }', '    // more tests', '}', ''].join('\n'),
    );
    assert.ok(await vscode.workspace.applyEdit(edit));
    const testDocument = await vscode.workspace.openTextDocument(testUri);
    assert.ok(await testDocument.save());
    assert.ok(await document.save());
    await vscode.window.showTextDocument(document);
    await until('the coverage run', () => runs > before && !orchestrator.isBusy);

    const expected = { uncovered: [lineOf(discount, 'return amount;')], partial: [lineOf(discount, 'if (isMember)')] };
    const applied = await until('decorations', () => api.decorationsOf(file(discount)));
    assert.deepStrictEqual(applied, expected);
    const view = coverage.fileView(file(discount))!;
    assert.deepStrictEqual(view.metrics.counts, { coverableLines: 6, coveredLines: 5, conditions: 2, coveredConditions: 1 });
    const status = api.statusText();
    assert.match(status, /^\$\(check\) \d+\/\d+ · New code \d+(\.\d)?% \(target 85%\)$/, status);
    console.log(`    status bar: ${status}`);
  });

  await step('turning coverage decorations off clears them, on restores them', async () => {
    const config = vscode.workspace.getConfiguration('aftershock');
    await config.update('coverageDecorations', false, vscode.ConfigurationTarget.Workspace);
    await until('no decorations', () => api.decorationsOf(file(discount)) === undefined || undefined);
    await config.update('coverageDecorations', true, vscode.ConfigurationTarget.Workspace);
    const applied = await until('decorations again', () => api.decorationsOf(file(discount)));
    assert.deepStrictEqual(applied.uncovered, [lineOf(discount, 'return amount;')]);
  });

  await step('a test for the other path covers everything: decorations disappear, 100% for the file', async () => {
    const before = runs;
    const testRelative = 'tests/Sample.Tests.XUnit/LoyaltyDiscountTests.cs';
    // A one-line anchor: VS Code gives the new file the platform's line endings.
    await editAndSave(testRelative, '    // more tests', ['', '    [Fact]', '    public void NonMember_PaysFull()', '    {', '        Assert.Equal(10m, DiscountCalculator.ApplyLoyalty(10m, false));', '    }'].join('\n'));
    await until('the runs (with the follow-up)', () => runs > before && !orchestrator.isBusy && api.decorationsOf(file(discount)) === undefined || undefined);
    const view = api.coverage!.fileView(file(discount))!;
    assert.deepStrictEqual(view.metrics.counts, { coverableLines: 6, coveredLines: 6, conditions: 2, coveredConditions: 2 });
  });

  await step('turning coverage off removes it from the status bar', async () => {
    const config = vscode.workspace.getConfiguration('aftershock');
    await config.update('coverageEnabled', false, vscode.ConfigurationTarget.Workspace);
    await until('status without coverage', () => !api.statusText().includes('New code') || undefined);
    await config.update('coverageEnabled', true, vscode.ConfigurationTarget.Workspace);
    await until('status with coverage', () => api.statusText().includes('New code') || undefined);
  });

  await step('the target branch catching up (a ref change outside the workspace folder) updates the new code', async () => {
    // Commit everything and move the fake origin/main there: no new code is left.
    const repo = path.resolve(workspace, '..', '..');
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Aftershock IT', '-c', 'user.email=it@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
    };
    git('add', '-A');
    git('commit', '-q', '-m', 'feature');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await until('no new code', () => (api.coverage!.summary().state === 'noNewCode' && api.statusText().endsWith('New code n/a')) || undefined, 30000);
    assert.strictEqual(api.decorationsOf(file(discount)), undefined);
  });

  await step('pause and resume', async () => {
    await vscode.commands.executeCommand('aftershock.togglePause');
    assert.strictEqual(orchestrator.isPaused, true);
    await vscode.commands.executeCommand('aftershock.togglePause');
    assert.strictEqual(orchestrator.isPaused, false);
    await vscode.commands.executeCommand('aftershock.showOutput');
  });
}
