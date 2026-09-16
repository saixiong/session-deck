import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatReview } from '../shared/review'
import { reconcileItems } from '../shared/board'
import { clampCompletion, clampPriority, priorityLabel } from '../shared/review'
import { writeFileAtomic } from '../util/atomicWrite'

/**
 * `<dataDir>/reviews/<sessionId>.json` (spec §4.2). One file per session so
 * the P6 skill can read a single report without parsing all of them. A file
 * whose JSON no longer parses is a cache miss, never a blank modal. A review
 * carrying `error` is never written (Chat Review D4).
 */
export class ReviewStore {
  private readonly cache = new Map<string, ChatReview>()
  private loaded = false

  constructor(readonly dir: string) {}

  async load(): Promise<void> {
    this.cache.clear()
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      // No reviews yet.
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const review = parseReviewFile(await readFile(join(this.dir, name), 'utf8').catch(() => ''))
      if (review) this.cache.set(review.conversation_id, review)
    }
    this.loaded = true
  }

  get(sessionId: string): ChatReview | undefined {
    return this.cache.get(sessionId)
  }

  all(): ChatReview[] {
    return [...this.cache.values()]
  }

  async set(review: ChatReview): Promise<void> {
    if (review.error) throw new Error('refusing to cache a failed review')
    if (!isSafeId(review.conversation_id)) throw new Error('bad session id')
    this.cache.set(review.conversation_id, review)
    await writeFileAtomic(
      join(this.dir, `${review.conversation_id}.json`),
      JSON.stringify(review, null, 2) + '\n'
    )
  }

  async delete(sessionId: string): Promise<boolean> {
    if (!isSafeId(sessionId)) return false
    const had = this.cache.delete(sessionId)
    try {
      await unlink(join(this.dir, `${sessionId}.json`))
      return true
    } catch {
      return had
    }
  }

  get isLoaded(): boolean {
    return this.loaded
  }
}

export function fingerprintOf(entry: { messageCount: number; lastActiveAt: string }): string {
  return `${entry.messageCount}:${entry.lastActiveAt}`
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

/** Tolerant reader: older payload shapes degrade to a re-analysis, not a crash. */
export function parseReviewFile(raw: string): ChatReview | undefined {
  if (!raw.trim()) return undefined
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  if (typeof r['conversation_id'] !== 'string' || !isSafeId(r['conversation_id'])) return undefined
  if (r['error']) return undefined
  const s = (k: string) => (typeof r[k] === 'string' ? r[k] : '')
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : [])
  const options = Array.isArray(r['options'])
    ? (r['options'] as unknown[])
        .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
        .map((o) => ({
          id: typeof o['id'] === 'string' ? o['id'] : '',
          label: typeof o['label'] === 'string' ? o['label'] : '',
          description: typeof o['description'] === 'string' ? o['description'] : '',
          prompt: typeof o['prompt'] === 'string' ? o['prompt'] : '',
        }))
        .filter((o) => o.label && o.prompt)
    : []
  const priority = clampPriority(r['priority'])
  const next_steps = list('next_steps')
  const blockers = list('blockers')
  // Re-derived rather than trusted: ids stay ours (B6) and a hand-edited file
  // cannot introduce an item the strings do not contain (B3).
  const items = reconcileItems(
    next_steps,
    blockers,
    Array.isArray(r['items'])
      ? (r['items'] as unknown[]).filter(
          (o): o is Record<string, unknown> => typeof o === 'object' && o !== null
        )
      : []
  )
  return {
    conversation_id: r['conversation_id'],
    title: s('title'),
    summary: s('summary'),
    done: list('done'),
    next_steps,
    blockers,
    priority,
    priority_label: priorityLabel(priority),
    priority_reason: s('priority_reason'),
    completion: clampCompletion(r['completion']),
    completion_reason: s('completion_reason'),
    items,
    options,
    model: s('model'),
    analyzed_at: s('analyzed_at'),
    fingerprint: s('fingerprint'),
    message_count: typeof r['message_count'] === 'number' ? r['message_count'] : 0,
    cost_usd: typeof r['cost_usd'] === 'number' ? r['cost_usd'] : null,
    duration_ms: typeof r['duration_ms'] === 'number' ? r['duration_ms'] : null,
    error: null,
  }
}
