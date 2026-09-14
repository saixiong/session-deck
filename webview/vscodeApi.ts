import type { HostToWebview, WebviewToHost } from '../src/shared/messages'
import { isHostToWebview } from '../src/shared/messages'

// acquireVsCodeApi() throws on a second call, so it is taken once at module load.
const api = acquireVsCodeApi()

export function post(message: WebviewToHost): void {
  api.postMessage(message)
}

export function onHostMessage(handler: (message: HostToWebview) => void): () => void {
  const listener = (event: MessageEvent<unknown>) => {
    // Anything that is not a known host message is ignored — a newer host
    // talking to an older webview must degrade, not throw.
    if (isHostToWebview(event.data)) handler(event.data)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
