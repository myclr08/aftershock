// Integration test: starts a real VS Code (the oldest supported version, engines.vscode) with the
// extension on a temporary git copy of samples/ImpactSample and runs test/integration/suite.ts in it.
//
//   npm run bundle-analyzer && npm run test:integration          (Windows, macOS)
//   xvfb-run -a npm run test:integration                         (Linux, no visible window)
//
// VS Code is downloaded into .vscode-test/ on the first run.
import { runTests } from '@vscode/test-electron';
import { spawnSync } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..', '..');
const sample = path.resolve(extensionRoot, '..', 'samples', 'ImpactSample');
const version = process.env.AFTERSHOCK_VSCODE_VERSION || '1.85.2';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aftershock-it-')));
const repo = path.join(root, 'repo');
const workspace = path.join(repo, 'samples', 'ImpactSample');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', DOTNET_NOLOGO: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  }
}

let exitCode = 0;
try {
  fs.cpSync(sample, workspace, { recursive: true, filter: (src) => !/[\\/](bin|obj|TestResults)$/.test(src) });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'bin/\nobj/\nTestResults/\n.vscode/\n');
  const git = ['-c', 'user.name=Aftershock IT', '-c', 'user.email=it@example.invalid', '-c', 'commit.gpgsign=false'];
  run('git', ['init', '-q', '-b', 'main'], repo);
  run('git', [...git, 'add', '-A'], repo);
  run('git', [...git, 'commit', '-q', '-m', 'baseline'], repo);
  run('dotnet', ['restore', 'ImpactSample.sln', '-nologo'], workspace);
  // A short debounce keeps the test quick.
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'aftershock.debounceMs': 300 }, null, 2));

  await esbuild.build({
    entryPoints: [path.join(here, 'suite.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    outfile: path.join(extensionRoot, 'out', 'integration', 'suite.js'),
    logLevel: 'warning',
  });

  await runTests({
    version,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, 'out', 'integration', 'suite.js'),
    extensionTestsEnv: { AFTERSHOCK_IT_WORKSPACE: workspace },
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
      `--user-data-dir=${path.join(root, 'user-data')}`,
      `--extensions-dir=${path.join(root, 'extensions')}`,
    ],
  });
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
