/** Minimal logging surface of the core; the VS Code layer maps it to a LogOutputChannel. */
export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const nullLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Collects log lines in memory (tests, e2e). */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];

  constructor(private readonly echo?: (line: string) => void) {}

  trace(message: string): void {
    this.add('trace', message);
  }

  debug(message: string): void {
    this.add('debug', message);
  }

  info(message: string): void {
    this.add('info', message);
  }

  warn(message: string): void {
    this.add('warn', message);
  }

  error(message: string): void {
    this.add('error', message);
  }

  private add(level: string, message: string): void {
    const line = `[${level}] ${message}`;
    this.lines.push(line);
    this.echo?.(line);
  }
}

/** "1.23 s" / "450 ms". */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}
