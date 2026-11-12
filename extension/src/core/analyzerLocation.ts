import * as fs from 'fs';
import * as path from 'path';

export const ANALYZER_DLL = 'aftershock-analyzer.dll';

export interface AnalyzerLocation {
  dll?: string;
  /** Every candidate in order, for the error message. */
  tried: string[];
}

/**
 * The analyzer the extension starts: `AFTERSHOCK_ANALYZER_DLL` (development override), the copy bundled
 * into the VSIX (`dist/analyzer`, see scripts/bundle-analyzer.mjs), then the build output of the
 * repository the extension runs from (development host).
 */
export function resolveAnalyzerDll(extensionPath: string, env: NodeJS.ProcessEnv = process.env): AnalyzerLocation {
  const repoProject = path.resolve(extensionPath, '..', 'analyzer', 'src', 'Aftershock.Analyzer');
  const candidates = [
    env.AFTERSHOCK_ANALYZER_DLL,
    path.join(extensionPath, 'dist', 'analyzer', ANALYZER_DLL),
    path.join(repoProject, 'bin', 'Release', 'net8.0', ANALYZER_DLL),
    path.join(repoProject, 'bin', 'Debug', 'net8.0', ANALYZER_DLL),
  ].filter((candidate): candidate is string => !!candidate);
  const dll = candidates.find((candidate) => fs.existsSync(candidate));
  return { dll, tried: candidates };
}
