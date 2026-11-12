import * as fs from 'fs';
import * as path from 'path';

/**
 * How `dotnet test` runs a test project (DESIGN.md 6.2):
 *
 * - `vstest`: classic VSTest (`--filter`, `--logger trx`).
 * - `bridge`: VSTest-mode `dotnet test` running a Microsoft.Testing.Platform app
 *   (`TestingPlatformDotnetTestSupport=true`). VSTest options such as `--filter`, `--logger` and
 *   `--results-directory` are ignored (warning MTP0001); the app's own options go after `--`.
 * - `mtp`: the .NET 10+ SDK's native MTP mode (`global.json` `"test": { "runner": "Microsoft.Testing.Platform" }`):
 *   `dotnet test --project <proj>` with the app's own options.
 */
export type RunnerMode = 'vstest' | 'bridge' | 'mtp';

/** MSBuild properties that decide the runner mode (queried with `dotnet msbuild -getProperty`). */
export const RUNNER_PROPERTIES = [
  'TestingPlatformDotnetTestSupport',
  'IsTestingPlatformApplication',
  'UseMicrosoftTestingPlatformRunner',
  'EnableMSTestRunner',
  'EnableNUnitRunner',
  'OutputType',
  'TargetFramework',
  'TargetFrameworks',
  'ProjectAssetsFile',
] as const;

export type ProjectProperties = Partial<Record<(typeof RUNNER_PROPERTIES)[number], string>>;

export interface GlobalJsonRunner {
  /** The global.json that was found (the SDK uses the nearest one above the working directory). */
  file?: string;
  runner?: string;
}

/** Strips // and /* *\/ comments (global.json allows them) outside of strings. */
export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      result += c;
      if (c === '\\') {
        result += text[++i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      result += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      result += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i++;
    } else {
      result += c;
    }
  }
  return result.replace(/,(\s*[}\]])/g, '$1');
}

/** Reads `test.runner` from the nearest global.json at or above `startDirectory`. */
export function readGlobalJsonRunner(startDirectory: string): GlobalJsonRunner {
  let directory = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(directory, 'global.json');
    if (fs.existsSync(candidate)) {
      try {
        const json = JSON.parse(stripJsonComments(fs.readFileSync(candidate, 'utf8'))) as { test?: { runner?: unknown } };
        const runner = typeof json.test?.runner === 'string' ? json.test.runner : undefined;
        return { file: candidate, runner };
      } catch {
        return { file: candidate };
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return {};
    }
    directory = parent;
  }
}

/** Parses `dotnet msbuild -getProperty:A -getProperty:B` output (`{"Properties":{...}}`). */
export function parseGetPropertyOutput(output: string): ProjectProperties {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error(`unexpected msbuild output: ${output.slice(0, 300)}`);
  }
  const json = JSON.parse(output.slice(start, end + 1)) as { Properties?: Record<string, string> };
  return json.Properties ?? {};
}

function isTrue(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

export interface RunnerDecision {
  mode: RunnerMode;
  reason: string;
}

export function decideRunnerMode(globalRunner: GlobalJsonRunner, properties: ProjectProperties | undefined): RunnerDecision {
  if (globalRunner.runner && globalRunner.runner.toLowerCase() === 'microsoft.testing.platform') {
    return { mode: 'mtp', reason: `${globalRunner.file ?? 'global.json'} sets test.runner = Microsoft.Testing.Platform` };
  }
  if (!properties) {
    return { mode: 'vstest', reason: 'project properties unavailable; assuming VSTest' };
  }
  const mtpApp = isTrue(properties.IsTestingPlatformApplication);
  if (mtpApp && isTrue(properties.TestingPlatformDotnetTestSupport)) {
    return { mode: 'bridge', reason: 'IsTestingPlatformApplication and TestingPlatformDotnetTestSupport are true (Microsoft.Testing.Platform app under VSTest dotnet test)' };
  }
  if (mtpApp) {
    return { mode: 'vstest', reason: 'Microsoft.Testing.Platform app without TestingPlatformDotnetTestSupport: dotnet test uses its VSTest adapter' };
  }
  return { mode: 'vstest', reason: 'VSTest (no Microsoft.Testing.Platform runner configured)' };
}

/** Which selection syntax the project's framework understands in an MTP mode. */
export type MtpFilterStyle = 'xunit' | 'vstest';

export function mtpFilterStyle(frameworks: readonly string[], properties: ProjectProperties | undefined): MtpFilterStyle {
  if (frameworks.includes('xunit') || isTrue(properties?.UseMicrosoftTestingPlatformRunner)) {
    // An xUnit project that runs on MTP is xUnit v3 (v2 has no MTP runner).
    return 'xunit';
  }
  return 'vstest';
}
