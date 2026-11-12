import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'test/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': 'off',
    },
  },
  {
    // The orchestration core must stay free of the vscode module so it can be tested in plain Node.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'src/core must not depend on vscode.' }] }],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
