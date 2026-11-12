// Publishes the analyzer (framework-dependent, portable: no runtime identifier, no app host) into
// dist/analyzer so the VSIX ships it. The extension starts it with `dotnet aftershock-analyzer.dll serve`.
//
//   node scripts/bundle-analyzer.mjs [--configuration Release] [--dotnet <path>]
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const project = path.resolve(extensionRoot, '..', 'analyzer', 'src', 'Aftershock.Analyzer', 'Aftershock.Analyzer.csproj');
const output = path.join(extensionRoot, 'dist', 'analyzer');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const configuration = option('--configuration', 'Release');
const dotnet = option('--dotnet', process.env.DOTNET_PATH || 'dotnet');

if (!fs.existsSync(project)) {
  console.error(`Analyzer project not found: ${project}`);
  process.exit(1);
}

fs.rmSync(output, { recursive: true, force: true });
const args = ['publish', project, '-c', configuration, '-o', output, '-p:UseAppHost=false', '-nologo'];
console.log(`> ${dotnet} ${args.join(' ')}`);
const result = spawnSync(dotnet, args, {
  stdio: 'inherit',
  env: { ...process.env, MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', DOTNET_NOLOGO: '1' },
});
if (result.error) {
  console.error(`Could not run ${dotnet}: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`dotnet publish failed with exit code ${result.status}`);
  process.exit(result.status ?? 1);
}

// Sanity checks: the files the extension and MSBuildWorkspace need at run time.
const required = ['aftershock-analyzer.dll', 'aftershock-analyzer.runtimeconfig.json', 'BuildHost-netcore'];
const missing = required.filter((name) => !fs.existsSync(path.join(output, name)));
if (missing.length > 0) {
  console.error(`The published analyzer is incomplete; missing: ${missing.join(', ')}`);
  process.exit(1);
}
const runtimeConfig = fs.readFileSync(path.join(output, 'aftershock-analyzer.runtimeconfig.json'), 'utf8');
if (!/"rollForward":\s*"LatestMajor"/.test(runtimeConfig)) {
  console.error('aftershock-analyzer.runtimeconfig.json does not roll forward to the newest runtime (LatestMajor).');
  process.exit(1);
}

let bytes = 0;
const count = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count(full);
    else bytes += fs.statSync(full).size;
  }
};
count(output);
console.log(`Analyzer bundled into ${path.relative(extensionRoot, output)} (${(bytes / 1024 / 1024).toFixed(1)} MB).`);
