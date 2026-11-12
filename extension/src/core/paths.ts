import * as path from 'path';

/**
 * Key for comparing file system paths: absolute, normalized, and case-insensitive on Windows and macOS
 * (their default file systems are case-insensitive).
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === 'win32' ? path.win32.normalize(p) : path.posix.normalize(p);
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** Display form of a command line (for the output channel only; processes are spawned without a shell). */
export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteForDisplay).join(' ');
}

function quoteForDisplay(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}
