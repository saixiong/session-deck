/**
 * The webview runtime provides acquireVsCodeApi(); tests get a recorder so
 * assertions can inspect what the component asked the host to do.
 */
export const posted: unknown[] = []

;(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: unknown) => {
    posted.push(m)
  },
  getState: () => undefined,
  setState: () => undefined,
})
