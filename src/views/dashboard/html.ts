import { randomBytes } from 'node:crypto'
import type { Webview } from 'vscode'

/**
 * The dashboard's HTML shell. Everything real lives in the bundled webview
 * script; this only wires CSP, the nonce, and the asset URIs.
 *
 * CSP is deliberately strict: no inline scripts, no remote anything. Styles and
 * fonts come from the extension's own dist/webview folder (codicons ship there).
 */
export function renderDashboardHtml(
  webview: Webview,
  assets: { script: string; style: string }
): string {
  const nonce = randomBytes(16).toString('base64')
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${assets.style}" />
  <title>Session Deck</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${assets.script}"></script>
</body>
</html>`
}
