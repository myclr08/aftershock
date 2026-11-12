import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAnyGlob } from '../../src/core/glob';

const matches = (pattern: string, file: string, caseInsensitive = false) => globToRegExp(pattern, { caseInsensitive }).test(file);

describe('coverage exclusion globs', () => {
  it('Ant-style ** matches any number of folders, * and ? stay in one segment', () => {
    expect(matches('**/Migrations/**', 'src/Data/Migrations/2024_Init.cs')).toBe(true);
    expect(matches('**/Migrations/**', 'Migrations/x.cs')).toBe(true);
    expect(matches('src/**/*.Designer.cs', 'src/App/Forms/Main.Designer.cs')).toBe(true);
    expect(matches('src/**/*.Designer.cs', 'src/Main.Designer.cs')).toBe(true);
    expect(matches('src/*.cs', 'src/App/Program.cs')).toBe(false);
    expect(matches('src/?.cs', 'src/A.cs')).toBe(true);
    expect(matches('src/?.cs', 'src/AB.cs')).toBe(false);
  });

  it('a pattern without a slash matches the file name at any depth', () => {
    expect(matches('*Generated.cs', 'src/App/ModelGenerated.cs')).toBe(true);
    expect(matches('*Generated.cs', 'ModelGenerated.cs')).toBe(true);
    expect(matches('Program.cs', 'src/Web/Program.cs')).toBe(true);
  });

  it('braces, character classes and a trailing slash', () => {
    expect(matches('**/*.{g,designer}.cs', 'a/b/View.g.cs')).toBe(true);
    expect(matches('**/*.{g,designer}.cs', 'a/b/View.designer.cs')).toBe(true);
    expect(matches('**/*.{g,designer}.cs', 'a/b/View.cs')).toBe(false);
    expect(matches('src/[AB]*/**', 'src/Api/x.cs')).toBe(true);
    expect(matches('src/[!AB]*/**', 'src/Api/x.cs')).toBe(false);
    expect(matches('src/Legacy/', 'src/Legacy/Old/Thing.cs')).toBe(true);
  });

  it('special characters in names are literal', () => {
    expect(matches('src/a+b (1)/*.cs', 'src/a+b (1)/x.cs')).toBe(true);
    expect(matches('src/a.b/*.cs', 'src/aXb/x.cs')).toBe(false);
  });

  it('case sensitivity follows the option', () => {
    expect(matches('**/migrations/**', 'src/Migrations/x.cs')).toBe(false);
    expect(matches('**/migrations/**', 'src/Migrations/x.cs', true)).toBe(true);
  });

  it('matchesAnyGlob tries every candidate path and accepts backslashes', () => {
    expect(matchesAnyGlob(['samples/App/src/Gen/X.cs', 'src\\Gen\\X.cs'], ['src/Gen/**'])).toBe('src/Gen/**');
    expect(matchesAnyGlob(['src/A.cs'], ['', '  ', 'tests/**'])).toBeUndefined();
    expect(matchesAnyGlob(['src/A.cs'], ['src\\*.cs'])).toBe('src\\*.cs');
  });
});
