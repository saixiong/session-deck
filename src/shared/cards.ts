/**
 * The render contract for anything favoritable (spec §6). One shape for every
 * entity type, so the webview has one card component and one picker row and
 * never learns what a "session" is versus a future "project" or "pr".
 *
 * Shared by host and webview: no vscode or Node imports here.
 */

export type FavoriteEntityType = 'session' | 'project' | 'pr'

export type StatusVariant = 'success' | 'warning' | 'error' | 'info' | 'default'

export interface CardDetail {
  label: string
  value: string
  /** `datetime` values are ISO strings; the webview formats them in the viewer's zone. */
  kind?: 'text' | 'datetime' | 'link' | 'number'
  href?: string
}

export interface FavoriteCard {
  entityType: FavoriteEntityType
  entityId: string
  title: string
  /** Static part of the subtitle ("snippbot · main"); the webview appends the relative time. */
  subtitle: string | null
  preview: string | null
  details: CardDetail[]
  status: string | null
  statusVariant: StatusVariant | null
  /** ISO — secondary sort and the relative-time suffix. */
  updatedAt: string | null
  /** Group key for the dashboard (project basename) and its display label. */
  group: { key: string; label: string }
  /** Type-specific extras the opener needs (cwd, slug, live pid…). */
  meta: Record<string, unknown>
}

/** A favorite row joined with its card, or marked missing when the entity is gone. */
export interface FavoriteItem {
  id: string
  entityType: FavoriteEntityType
  entityId: string
  label: string
  note: string | null
  sortOrder: number
  createdAt: string
  card: FavoriteCard | null
  missing: boolean
}

export interface FavoriteGroup {
  entityType: FavoriteEntityType
  label: string
  icon: string
  items: FavoriteItem[]
}

/** Human-readable distance in either direction ("in 22h", "5h ago", "just now"). */
export function formatTimeDistance(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diff = then - now
  const abs = Math.abs(diff)
  const minutes = Math.round(abs / 60_000)
  if (minutes < 1) return 'just now'
  const unit =
    minutes < 60
      ? `${minutes}m`
      : minutes < 60 * 24
        ? `${Math.round(minutes / 60)}h`
        : minutes < 60 * 24 * 30
          ? `${Math.round(minutes / (60 * 24))}d`
          : `${Math.round(minutes / (60 * 24 * 30))}mo`
  return diff > 0 ? `in ${unit}` : `${unit} ago`
}
