import { defineConfig } from 'vitest/config'

// Two projects: host code under Node, webview components under happy-dom.
// The e2e smoke suite (test/e2e) runs inside a real VS Code instead.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'webview',
          include: ['webview/**/*.test.tsx'],
          environment: 'happy-dom',
          setupFiles: ['webview/test/setup.ts'],
        },
        esbuild: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: false },
        resolve: {
          alias: {
            'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
            'react/jsx-runtime': 'preact/jsx-runtime',
          },
        },
      },
    ],
  },
})
