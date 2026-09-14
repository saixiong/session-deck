// Two bundles: the extension host (Node, CommonJS, `vscode` external) and the
// webview (browser, ESM, Preact). Both come out under dist/ so .vscodeignore
// can ship a single folder. `--watch` rebuilds on change; `--production`
// minifies and drops sourcemaps.
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')
const production = process.argv.includes('--production')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  target: ['es2022'],
}

const host = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
})

// The e2e suite runs inside VS Code's extension host (mocha), so it is
// bundled the same way as the extension itself.
const e2e = await esbuild.context({
  ...common,
  entryPoints: ['test/e2e/extension.test.ts'],
  outfile: 'out/test/e2e/extension.test.js',
  format: 'cjs',
  platform: 'node',
  external: ['vscode', 'mocha'],
})

const webview = await esbuild.context({
  ...common,
  entryPoints: ['webview/index.tsx'],
  outdir: 'dist/webview',
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // codicon.css references codicon.ttf; the file loader copies it next to the bundle.
  loader: { '.ttf': 'file' },
  assetNames: '[name]',
})

if (watch) {
  await Promise.all([host.watch(), e2e.watch(), webview.watch()])
} else {
  await Promise.all([host.rebuild(), e2e.rebuild(), webview.rebuild()])
  await Promise.all([host.dispose(), e2e.dispose(), webview.dispose()])
}
