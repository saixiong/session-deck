import { defineConfig } from '@vscode/test-cli'

export default defineConfig({
  files: 'dist/test/e2e/**/*.test.js',
  version: 'stable',
  // A throwaway workspace so the extension never sees a real project during tests.
  workspaceFolder: 'test/fixtures/workspace',
  mocha: { ui: 'tdd', timeout: 30_000 },
})
