import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', '.vscode-test/**', 'node_modules/**', '*.vsix'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Four TS projects (host, host tests, webview, e2e); the first one that
        // includes a file wins, so order matters: tests before host.
        project: [
          './tsconfig.test.json',
          './tsconfig.json',
          './tsconfig.webview.json',
          './tsconfig.e2e.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Config and build scripts are plain ESM, not part of a tsconfig project.
    files: ['*.mjs', '*.mts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: 'readonly' } },
  }
)
