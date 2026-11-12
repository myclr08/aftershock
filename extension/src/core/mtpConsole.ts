// Fallback when a Microsoft.Testing.Platform test app has no TRX report extension
// (DESIGN.md 6.5: "console parsing is the fallback"). Only failures are listed on the console by
// default, so passed tests are inferred from the selection and the exit code.

export interface ConsoleFailure {
  /** The name as printed (`Ns.Class.Method(args)` for xUnit, `Method(args)` / `Method (args)` for NUnit/MSTest). */
  name: string;
  message: string;
}

export interface ConsoleSummary {
  failures: ConsoleFailure[];
  total?: number;
  failed?: number;
  succeeded?: number;
  skipped?: number;
}

const FAILED_LINE = /^\s*failed\s+(.+?)\s+\(\d+(?:\.\d+)?\s*(?:ms|s|m)\)\s*$/;

/** Parses `failed <name> (12ms)` blocks and the `total: / failed: / succeeded: / skipped:` summary. */
export function parseMtpConsole(output: string): ConsoleSummary {
  const lines = output.split(/\r?\n/);
  const failures: ConsoleFailure[] = [];
  const summary: ConsoleSummary = { failures };
  for (let i = 0; i < lines.length; i++) {
    const match = FAILED_LINE.exec(lines[i]);
    if (match) {
      const message: string[] = [];
      for (let j = i + 1; j < lines.length && message.length < 12; j++) {
        const line = lines[j];
        if (FAILED_LINE.test(line) || /^\s*(passed|skipped)\s+/.test(line) || /^\s*from\s+/.test(line) || line.trim() === '') {
          break;
        }
        message.push(line.trim());
      }
      failures.push({ name: match[1], message: message.join('\n') });
      continue;
    }
    const count = /^\s*(total|failed|succeeded|skipped):\s*(\d+)\s*$/.exec(lines[i]);
    if (count) {
      summary[count[1] as 'total' | 'failed' | 'succeeded' | 'skipped'] = Number(count[2]);
    }
  }
  return summary;
}
