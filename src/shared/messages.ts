/**
 * The typed contract between the extension host and the dashboard webview.
 *
 * This file is the ONLY thing both sides import (see tsconfig.webview.json),
 * so it must stay free of `vscode` and Node imports. Every message crossing
 * `postMessage` is one of these unions; `isWebviewToHost` / `isHostToWebview`
 * are the runtime guards the receivers use, because postMessage is untyped and
 * a stale webview talking to a newer host must be ignored, never crash it.
 *
 * Later phases add favorites, review and open messages here — and nowhere else.
 */

export type Period = '24h' | '7d' | '30d'
export const PERIODS: readonly Period[] = ['24h', '7d', '30d']

export interface StatTileData {
  id: string
  label: string
  /** Pre-formatted for display; the host owns number formatting. */
  value: string
  /** Optional secondary line ("of 892", "≈ while indexing"). */
  hint?: string
  tooltip?: string
}

export interface IndexSummary {
  total: number
  complete: number
  pending: number
  fastOnly: number
  missing: number
  parseErrors: number
  scanning: boolean
}

export interface DashboardState {
  extensionVersion: string
  period: Period
  stats: StatTileData[]
  index: IndexSummary
}

export type HostToWebview = { type: 'state'; state: DashboardState }

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'openExternal'; url: string }
  | { type: 'setPeriod'; period: Period }
  | { type: 'command'; command: 'reload' | 'reindex' }

const HOST_TYPES: ReadonlySet<string> = new Set(['state'])
const WEBVIEW_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'openExternal',
  'setPeriod',
  'command',
])
const COMMANDS: ReadonlySet<string> = new Set(['reload', 'reindex'])

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
  if (value.type === 'setPeriod') {
    return PERIODS.includes((value as { period?: unknown }).period as Period)
  }
  if (value.type === 'command') {
    const command = (value as { command?: unknown }).command
    return typeof command === 'string' && COMMANDS.has(command)
  }
  return true
}
