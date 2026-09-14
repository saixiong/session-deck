// The VS Code webview runtime injects this; it may be called exactly once.
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare module '*.css'
