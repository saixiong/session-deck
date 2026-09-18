import type { LiveSession } from '../index/liveSessions'
import { resolveTitle } from '../index/records'
import { matchesQuery, normaliseQuery } from '../index/search'
import { projectLabel } from '../index/project'
import { formatCount } from '../index/stats'
import type { SessionIndexEntry } from '../index/types'
import type { CardDetail, FavoriteCard } from '../shared/cards'
import type { FavoriteResolver } from './types'

/**
 * The one resolver v1 ships. Entirely index-backed, so hydrate/browse/suggest
 * are in-memory lookups — no N+1 is possible and the picker may filter every
 * entry on each keystroke.
 */
export interface SessionResolverDeps {
  entries(): Iterable<SessionIndexEntry>
  get(sessionId: string): SessionIndexEntry | undefined
  /** Cached by the caller; refreshed on its own cadence. */
  live(): readonly LiveSession[]
  isVisible(entry: SessionIndexEntry): boolean
  /** Workspace folder paths, used to rank the current project first. */
  workspaceFolders(): readonly string[]
}

export class SessionResolver implements FavoriteResolver {
  readonly entityType = 'session' as const
  readonly label = 'Sessions'
  readonly icon = 'comment-discussion'

  constructor(private readonly deps: SessionResolverDeps) {}

  hydrate(ids: readonly string[]): Map<string, FavoriteCard> {
    const live = this.liveById()
    const out = new Map<string, FavoriteCard>()
    for (const id of ids) {
      const entry = this.deps.get(id)
      // A missing entry is a real "gone" — hydration ignores visibility on
      // purpose: a starred SDK session stays a card even when the list hides SDK sessions.
      if (!entry || entry.missing) continue
      out.set(id, this.card(entry, live.get(id)))
    }
    return out
  }

  browse(query: string | null, limit: number): { items: FavoriteCard[]; total: number } {
    const words = normaliseQuery(query)
    const live = this.liveById()
    const matches: SessionIndexEntry[] = []
    for (const entry of this.deps.entries()) {
      if (entry.missing || !this.deps.isVisible(entry)) continue
      if (!matchesQuery(entry, words)) continue
      matches.push(entry)
    }
    matches.sort(byRecency)
    return {
      items: matches.slice(0, limit).map((e) => this.card(e, live.get(e.sessionId))),
      total: matches.length,
    }
  }

  suggest(limit: number, exclude: ReadonlySet<string>): FavoriteCard[] {
    const live = this.liveById()
    const candidates: SessionIndexEntry[] = []
    for (const entry of this.deps.entries()) {
      if (entry.missing || exclude.has(entry.sessionId) || !this.deps.isVisible(entry)) continue
      // A session with no human prompt (an aborted start) teaches nothing.
      if (!entry.firstPrompt && !entry.aiTitle && !entry.customTitle) continue
      candidates.push(entry)
    }
    candidates.sort(byRecency)
    return candidates.slice(0, limit).map((e) => this.card(e, live.get(e.sessionId)))
  }

  /** Every visible session, newest first — the sidebar's Recent list. */
  recent(): SessionIndexEntry[] {
    const out: SessionIndexEntry[] = []
    for (const entry of this.deps.entries()) {
      if (!entry.missing && this.deps.isVisible(entry)) out.push(entry)
    }
    return out.sort(byRecency)
  }

  card(entry: SessionIndexEntry, live?: LiveSession): FavoriteCard {
    const project = projectLabel(entry)
    const branch = entry.gitBranches[entry.gitBranches.length - 1]
    const details: CardDetail[] = [
      { label: 'Turns', value: String(entry.userTurns), kind: 'number' },
      { label: 'Tool calls', value: String(entry.toolUses), kind: 'number' },
      {
        label: 'Output tokens',
        value: `${entry.fast ? '≈' : ''}${formatCount(entry.tokens.output)}`,
        kind: 'number',
      },
    ]
    for (const pr of entry.prLinks)
      details.push({ label: 'PR', value: `#${pr.number}`, kind: 'link', href: pr.url })
    if (entry.models.length)
      details.push({ label: 'Model', value: entry.models.map(shortModel).join(', ') })
    if (entry.compactions)
      details.push({ label: 'Compactions', value: String(entry.compactions), kind: 'number' })
    if (entry.createdAt)
      details.push({ label: 'Started', value: entry.createdAt, kind: 'datetime' })
    return {
      entityType: 'session',
      entityId: entry.sessionId,
      title: resolveTitle(entry),
      subtitle: [project, branch].filter(Boolean).join(' · '),
      preview: entry.preview,
      details,
      status: live ? 'live' : null,
      statusVariant: live ? 'success' : null,
      updatedAt: entry.lastActiveAt || null,
      group: { key: entry.cwd || entry.slug, label: project },
      meta: {
        slug: entry.slug,
        cwd: entry.cwd,
        entrypoint: entry.entrypoint,
        filePath: entry.filePath,
        livePid: live?.pid ?? null,
        liveName: live?.name ?? null,
        inWorkspace: this.inWorkspace(entry),
      },
    }
  }

  inWorkspace(entry: SessionIndexEntry): boolean {
    const cwd = entry.cwd
    if (!cwd) return false
    return this.deps
      .workspaceFolders()
      .some((f) => cwd === f || cwd.startsWith(f.endsWith('/') ? f : `${f}/`))
  }

  private liveById(): Map<string, LiveSession> {
    const map = new Map<string, LiveSession>()
    for (const l of this.deps.live()) map.set(l.sessionId, l)
    return map
  }
}

export { projectLabel } from '../index/project'

export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function byRecency(a: SessionIndexEntry, b: SessionIndexEntry): number {
  return a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0
}
