/**
 * The typed contract between the extension host and the dashboard webview.
 *
 * This file is the ONLY thing both sides import (see tsconfig.webview.json),
 * so it must stay free of `vscode` and Node imports. Every message crossing
 * `postMessage` is one of these unions; `isWebviewToHost` / `isHostToWebview`
 * are the runtime guards the receivers use, because postMessage is untyped and
 * a stale webview talking to a newer host must be ignored, never crash it.
 *
 * P0 ships the handshake and a placeholder state. Later phases add favorites,
 * index, review and open messages here — and nowhere else.
 */

export interface StatTileData {
  id: string
  label: string
  /** Pre-formatted for display; the host owns number formatting. */
  value: string
  /** Optional secondary line ("of 892", "≈ while indexing"). */
  hint?: string
  tooltip?: string
}

export interface DashboardState {
  extensionVersion: string
  /** Which phase of the spec the running build implements — surfaced in the UI while scaffolding. */
  phase: 'P0'
  stats: StatTileData[]
}

export type HostToWebview = { type: 'state'; state: DashboardState }

export type WebviewToHost =
  { type: 'ready' } | { type: 'openExternal'; url: string } | { type: 'command'; command: 'reload' }

const HOST_TYPES: ReadonlySet<string> = new Set(['state'])
const WEBVIEW_TYPES: ReadonlySet<string> = new Set(['ready', 'openExternal', 'command'])

function hasType(value: unknown): value is { type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

export function isHostToWebview(value: unknown): value is HostToWebview {
  return hasType(value) && HOST_TYPES.has(value.type)
}

export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (!hasType(value) || !WEBVIEW_TYPES.has(value.type)) return false
  if (value.type === 'openExternal') {
    return typeof (value as { url?: unknown }).url === 'string'
  }
  if (value.type === 'command') {
    return (value as { command?: unknown }).command === 'reload'
  }
  return true
}
