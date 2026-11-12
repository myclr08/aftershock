import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A fresh temporary folder, removed by the returned cleanup function. */
export function tempDir(prefix = 'aftershock-unit-'): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function writeFile(file: string, content: string, mtimeMs?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeMs !== undefined) {
    const time = new Date(mtimeMs);
    fs.utimesSync(file, time, time);
  }
}

/** Is a process alive? (signal 0 only checks.) */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 10000, stepMs = 25): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
