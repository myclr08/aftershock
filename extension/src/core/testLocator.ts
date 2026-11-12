import * as fs from 'fs';
import * as path from 'path';
import { firstStackLocation } from './trx';

export interface SourceLocation {
  file: string;
  /** 1-based. */
  line: number;
}

/** Words that can precede a call but never a method name in a declaration. */
const NOT_A_RETURN_TYPE = new Set(['return', 'await', 'new', 'throw', 'yield', 'else', 'case', 'in', 'is', 'as', 'nameof', 'typeof', 'when', 'and', 'or', 'not', 'var']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `Ns.Outer+Inner` -> `Inner`; generic arity suffixes (`Class`1`) are dropped. */
export function simpleClassName(className: string): string {
  const last = className.split(/[.+]/).pop() ?? className;
  return last.replace(/`\d+$/, '');
}

/**
 * 1-based line of the declaration of `methodName` in `text`, preferring one after the declaration of
 * the (simple) class name. Matches `void M(`, `Task M(`, `async ValueTask<T> M<T>(` and similar.
 */
export function findMethodDeclarationLine(text: string, className: string, methodName: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const classPattern = new RegExp(`\\b(class|record|struct)\\s+${escapeRegExp(simpleClassName(className))}\\b`);
  const methodPattern = new RegExp(`(?:^|[\\s(])([A-Za-z_][\\w.]*(?:<[^()]*>)?(?:\\[\\])?\\??)\\s+${escapeRegExp(methodName)}\\s*(<[^>]*>)?\\s*\\(`);
  const classLine = lines.findIndex((line) => classPattern.test(line));
  const search = (from: number): number | undefined => {
    for (let i = Math.max(from, 0); i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) {
        continue;
      }
      const match = methodPattern.exec(line);
      if (match && !NOT_A_RETURN_TYPE.has(match[1])) {
        return i + 1;
      }
    }
    return undefined;
  };
  return (classLine >= 0 ? search(classLine) : undefined) ?? search(0);
}

/** Start/end columns (0-based) of the method name on a line, or of the line's text. */
export function rangeOnLine(lineText: string, methodName: string): { start: number; end: number } {
  const match = new RegExp(`\\b${escapeRegExp(methodName)}\\b`).exec(lineText);
  if (match) {
    return { start: match.index, end: match.index + methodName.length };
  }
  const start = lineText.length - lineText.trimStart().length;
  return { start, end: Math.max(start + 1, lineText.trimEnd().length) };
}

function* csharpFiles(directory: string, depth = 0): Generator<string> {
  if (depth > 12) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (lower !== 'bin' && lower !== 'obj' && lower !== 'testresults' && !lower.startsWith('.')) {
        yield* csharpFiles(full, depth + 1);
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
      yield full;
    }
  }
}

export interface LocateRequest {
  className: string;
  methodName: string;
  /** Known declaration (from the analyzer report). */
  known?: SourceLocation;
  stackTrace?: string;
  /** Folder of the test project, searched when nothing else helps. */
  projectDirectory?: string;
}

/**
 * Where to show a failed test: the analyzer's declaration; else the declaration found in the file of
 * the first stack frame; else the first file of the test project declaring the class and the method;
 * else the stack frame itself.
 */
export function locateTest(request: LocateRequest): SourceLocation | undefined {
  if (request.known?.file && request.known.line > 0 && fs.existsSync(request.known.file)) {
    return request.known;
  }
  const frame = firstStackLocation(request.stackTrace, request.className);
  if (frame && fs.existsSync(frame.file)) {
    try {
      const line = findMethodDeclarationLine(fs.readFileSync(frame.file, 'utf8'), request.className, request.methodName);
      if (line) {
        return { file: frame.file, line };
      }
    } catch {
      // Fall through to the project search.
    }
  }
  if (request.projectDirectory) {
    const simple = simpleClassName(request.className);
    const classPattern = new RegExp(`\\b(class|record|struct)\\s+${escapeRegExp(simple)}\\b`);
    for (const file of csharpFiles(request.projectDirectory)) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!classPattern.test(text) || !text.includes(request.methodName)) {
        continue;
      }
      const line = findMethodDeclarationLine(text, request.className, request.methodName);
      if (line) {
        return { file, line };
      }
    }
  }
  return frame && fs.existsSync(frame.file) ? frame : undefined;
}
