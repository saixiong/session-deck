/**
 * The typed contract between the extension host and the dashboard webview.
 *
 * This file is the ONLY thing both sides import (see tsconfig.webview.json),
 * so it must stay free of `vscode` and Node imports. Every message crossing
 * `postMessage` is one of these unions; `isWebviewToHost` / `isHostToWebview`
 * are the runtime guards the receivers use, because postMessage is untyped and
 * a stale webview talking to a newer host must be ignored, never crash it.
 */
import type { BoardItemKind, BoardItemState, ReviewItem } from './board'
import type { FavoriteCard, FavoriteEntityType, FavoriteGroup } from './cards'
import type { BatchProgress, ChatReview } from './review'

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

/** Per-user view preferences, persisted by the host (globalState) so windows agree. */
export type DashboardMode = 'favorites' | 'board'

export interface DashboardPrefs {
  view: 'grid' | 'list'
  verbose: boolean
  /** Which face of the dashboard is showing (SPEC_BOARD B1). */
  mode: DashboardMode
  /** Board kind filter; empty means every kind. */
  boardKinds: BoardItemKind[]
  /** Board: show rows already marked done or dismissed. */
  boardShowClosed: boolean
  /** Section tip strips the user explicitly expanded/collapsed, by entity type. */
  tips: Record<string, boolean>
  /** Collapsed sections, by section id. */
  collapsed: Record<string, boolean>
}

export const DEFAULT_PREFS: DashboardPrefs = {
  view: 'grid',
  verbose: true,
  mode: 'favorites',
  boardKinds: [],
  boardShowClosed: false,
  tips: {},
  collapsed: {},
}

export interface ReviewState {
  /** Cached reports by session id, each flagged stale when the transcript moved on. */
  reviews: Record<string, ChatReview & { stale: boolean }>
  batch: BatchProgress | null
  /** Sessions the modal lists beyond favorites (e.g. reviewed from the tree — Q2), with their cards. */
  extraIds: string[]
  extraCards: Record<string, FavoriteCard>
  model: string
  cli: { found: boolean; path: string | null; source: string | null }
}

/** One row of the Board: a review item joined with its state and its session's facts (B5). */
export interface BoardRow {
  sessionId: string
  sessionTitle: string
  project: string | null
  priority: number
  priorityLabel: string
  completion: number | null
  stale: boolean
  item: ReviewItem
  state: BoardItemState | null
}

export interface BoardState {
  rows: BoardRow[]
  /** Starred sessions with no report yet — the board cannot list what was never reviewed. */
  unreviewed: number
  /** Starred sessions in total, so an empty board can say which kind of empty it is (B5.2). */
  starred: number
}

export interface DashboardState {
  extensionVersion: string
  period: Period
  stats: StatTileData[]
  index: IndexSummary
  prefs: DashboardPrefs
  groups: FavoriteGroup[]
  live: FavoriteCard[]
  suggested: FavoriteCard[]
  /** Group keys of the current workspace folders, so those groups sort first. */
  workspaceKeys: string[]
  /** Which entity types can be browsed by the picker. */
  browsable: FavoriteEntityType[]
  review: ReviewState
  board: BoardState
}

export interface CandidatesPayload {
  entityType: FavoriteEntityType
  query: string
  items: Array<FavoriteCard & { favorited: boolean }>
  total: number
  limit: number
}

export type HostToWebview =
  | { type: 'state'; state: DashboardState }
  | { type: 'candidates'; payload: CandidatesPayload }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'showReview'; focus: string | null }

export type OpenTargetChoice = 'default' | 'window' | 'terminal'

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'openExternal'; url: string }
  | { type: 'setPeriod'; period: Period }
  | { type: 'setPrefs'; prefs: Partial<DashboardPrefs> }
  | { type: 'command'; command: 'reload' | 'reindex' }
  | { type: 'toggleFavorite'; entityType: FavoriteEntityType; entityId: string; label: string }
  | { type: 'removeFavorite'; id: string }
  | { type: 'moveFavorite'; id: string; beforeId: string | null }
  | {
      type: 'open'
      entityType: FavoriteEntityType
      entityId: string
      prompt?: string
      target?: OpenTargetChoice
    }
  | { type: 'browse'; entityType: FavoriteEntityType; query: string; limit: number }
  | { type: 'reviewAnalyze'; ids: string[] | null; force: boolean }
  | { type: 'reviewCancel' }
  | { type: 'reviewDelete'; sessionId: string }
  | { type: 'reviewDismissExtra'; sessionId: string }
  /** Done / Dismiss / clear, one message for a whole bulk action (B5.2). */
  | {
      type: 'boardSetState'
      items: Array<{ sessionId: string; itemId: string; text: string }>
      state: BoardItemState | null
    }
  /** Seed one session's selected items and mark them seeded (B6). */
  | {
      type: 'boardSeed'
      sessionId: string
      items: Array<{ itemId: string; text: string }>
      /** Copy the composed prompt to the clipboard without opening anything. */
      copyOnly?: boolean
    }

const HOST_TYPES: ReadonlySet<string> = new Set(['state', 'candidates', 'toast', 'showReview'])
const WEBVIEW_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'openExternal',
  'setPeriod',
  'setPrefs',
  'command',
  'toggleFavorite',
  'removeFavorite',
  'moveFavorite',
  'open',
  'browse',
  'reviewAnalyze',
  'reviewCancel',
  'reviewDelete',
  'reviewDismissExtra',
  'boardSetState',
  'boardSeed',
])
const BOARD_STATES: ReadonlySet<string> = new Set(['done', 'dismissed', 'seeded'])
const COMMANDS: ReadonlySet<string> = new Set(['reload', 'reindex'])
const ENTITY_TYPES: ReadonlySet<string> = new Set(['session', 'project', 'pr'])
const TARGETS: ReadonlySet<string> = new Set(['default', 'window', 'terminal'])

function hasType(value: unknown): value is { type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

const str = (v: unknown): v is string => typeof v === 'string'

export function isHostToWebview(value: unknown): value is HostToWebview {
  return hasType(value) && HOST_TYPES.has(value.type)
}

export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (!hasType(value) || !WEBVIEW_TYPES.has(value.type)) return false
  const v = value as Record<string, unknown>
  switch (value.type) {
    case 'ready':
      return true
    case 'openExternal':
      return str(v['url'])
    case 'setPeriod':
      return PERIODS.includes(v['period'] as Period)
    case 'setPrefs':
      return typeof v['prefs'] === 'object' && v['prefs'] !== null
    case 'command':
      return str(v['command']) && COMMANDS.has(v['command'])
    case 'toggleFavorite':
      return (
        str(v['entityType']) &&
        ENTITY_TYPES.has(v['entityType']) &&
        str(v['entityId']) &&
        str(v['label'])
      )
    case 'removeFavorite':
      return str(v['id'])
    case 'moveFavorite':
      return str(v['id']) && (v['beforeId'] === null || str(v['beforeId']))
    case 'open':
      return (
        str(v['entityType']) &&
        ENTITY_TYPES.has(v['entityType']) &&
        str(v['entityId']) &&
        (v['prompt'] === undefined || str(v['prompt'])) &&
        (v['target'] === undefined || (str(v['target']) && TARGETS.has(v['target'])))
      )
    case 'browse':
      return (
        str(v['entityType']) &&
        ENTITY_TYPES.has(v['entityType']) &&
        str(v['query']) &&
        typeof v['limit'] === 'number'
      )
    case 'reviewAnalyze':
      return (
        (v['ids'] === null || (Array.isArray(v['ids']) && v['ids'].every(str))) &&
        typeof v['force'] === 'boolean'
      )
    case 'reviewCancel':
      return true
    case 'reviewDelete':
    case 'reviewDismissExtra':
      return str(v['sessionId'])
    case 'boardSetState':
      return (
        (v['state'] === null || (str(v['state']) && BOARD_STATES.has(v['state']))) &&
        Array.isArray(v['items']) &&
        v['items'].every(
          (i) =>
            typeof i === 'object' &&
            i !== null &&
            str((i as Record<string, unknown>)['sessionId']) &&
            str((i as Record<string, unknown>)['itemId']) &&
            str((i as Record<string, unknown>)['text'])
        )
      )
    case 'boardSeed':
      return (
        str(v['sessionId']) &&
        (v['copyOnly'] === undefined || typeof v['copyOnly'] === 'boolean') &&
        Array.isArray(v['items']) &&
        v['items'].every(
          (i) =>
            typeof i === 'object' &&
            i !== null &&
            str((i as Record<string, unknown>)['itemId']) &&
            str((i as Record<string, unknown>)['text'])
        )
      )
    default:
      return false
  }
}
