import type { LiveSession } from './liveSessions'
import type { SessionIndexEntry } from './types'

export type Period = '24h' | '7d' | '30d'

export const PERIOD_MS: Record<Period, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export function isPeriod(value: unknown): value is Period {
  return value === '24h' || value === '7d' || value === '30d'
}

export interface PeriodStats {
  live: number
  active: number
  /** Output tokens of sessions active in the period. `approximate` when any of them is still fast-tier. */
  outputTokens: number
  approximate: boolean
  prs: number
}

/**
 * Stat-strip numbers from the index alone — zero model calls, zero file reads
 * (spec §8.2). Token totals are per session, so a session that straddles the
 * period boundary contributes all of its tokens; that is documented in the
 * tile's hint rather than solved with per-message bucketing the index does
 * not keep.
 */
export function computeStats(
  entries: Iterable<SessionIndexEntry>,
  live: LiveSession[],
  period: Period,
  now = Date.now()
): PeriodStats {
  const since = new Date(now - PERIOD_MS[period]).toISOString()
  let active = 0
  let outputTokens = 0
  let approximate = false
  let prs = 0
  for (const entry of entries) {
    if (entry.missing || entry.lastActiveAt < since) continue
    active++
    outputTokens += entry.tokens.output
    if (entry.fast) approximate = true
    prs += entry.prLinks.length
  }
  return { live: live.length, active, outputTokens, approximate, prs }
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}
