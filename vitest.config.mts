import { defineConfig } from 'vitest/config'

// Host-side unit tests only. The webview is exercised by the e2e smoke suite
// (test/e2e) and, later, by its own DOM tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
})
