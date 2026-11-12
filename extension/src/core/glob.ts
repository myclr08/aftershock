/**
 * Glob patterns for `aftershock.coverageExclusions` (and, from M5a, the server's
 * `sonar.coverage.exclusions` / `sonar.exclusions`). Ant-style like Sonar: `**` matches any number of
 * folders, `*` and `?` stay inside one path segment; `{a,b}` and `[...]` are accepted as well. A
 * pattern without `/` matches the file name at any depth (as `aftershock.fallbackGlobs` does).
 */
export interface GlobOptions {
  caseInsensitive?: boolean;
}

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const key = `${options.caseInsensitive ? 'i' : 's'}|${pattern}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  let glob = pattern.trim().replace(/\\/g, '/');
  if (!glob.includes('/')) {
    glob = `**/${glob}`;
  }
  glob = glob.replace(/^\.\//, '').replace(/^\/+/, '');
  if (glob.endsWith('/')) {
    // "src/Legacy/" means everything below it.
    glob += '**';
  }

  let source = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        let end = i + 2;
        while (glob[end] === '*') {
          end++;
        }
        if (atSegmentStart && glob[end] === '/') {
          // "**/" : zero or more whole folders.
          source += '(?:[^/]*/)*';
          i = end;
          continue;
        }
        if (atSegmentStart && end === glob.length) {
          // Trailing "**": everything below.
          source += '.*';
          i = end - 1;
          continue;
        }
        // "a**b" behaves like "a*b".
        source += '[^/]*';
        i = end - 1;
        continue;
      }
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close < 0) {
        source += '\\[';
      } else {
        let body = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
        if (body.startsWith('!')) {
          body = `^${body.slice(1)}`;
        }
        source += `[${body}]`;
        i = close;
      }
    } else if (c === '{') {
      braceDepth++;
      source += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      source += ')';
    } else if (c === ',' && braceDepth > 0) {
      source += '|';
    } else {
      source += c.replace(/[.+^${}()|\\/]/g, '\\$&');
    }
  }
  source += ')'.repeat(braceDepth);
  const regex = new RegExp(`^${source}$`, options.caseInsensitive ? 'i' : '');
  cache.set(key, regex);
  return regex;
}

/** Does any pattern match any of the candidate relative paths (forward or back slashes)? */
export function matchesAnyGlob(relativePaths: readonly string[], patterns: readonly string[], options: GlobOptions = {}): string | undefined {
  const candidates = relativePaths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));
  for (const pattern of patterns) {
    if (!pattern || !pattern.trim()) {
      continue;
    }
    const regex = globToRegExp(pattern, options);
    if (candidates.some((candidate) => regex.test(candidate))) {
      return pattern;
    }
  }
  return undefined;
}
