import type { ChatReview } from './review'

/**
 * The Deck Board's item model (SPEC_BOARD B3, B4). Shared by host, webview and
 * the skill CLI — no vscode, no Node imports, so every surface derives the same
 * ids from the same report without coordinating.
 */
export type BoardItemKind = 'mechanical' | 'decision' | 'user_action' | 'unclassified'
export type BoardItemSource = 'next_step' | 'blocker'
export type BoardItemEffort = 'small' | 'medium' | 'large'

export interface ReviewItem {
  /** `itemIdOf(text)` — derived here, never supplied by the model (B6). */
  id: string
  /** Verbatim from `next_steps[]` / `blockers[]`; those arrays stay canonical (B3). */
  text: string
  source: BoardItemSource
  kind: BoardItemKind
  effort: BoardItemEffort | null
}

/** Stored per item in `board.json`; absent means open. */
export type BoardItemState = 'done' | 'dismissed' | 'seeded'

export const BOARD_KINDS: BoardItemKind[] = [
  'mechanical',
  'decision',
  'user_action',
  'unclassified',
]

export const KIND_LABELS: Record<BoardItemKind, string> = {
  mechanical: 'Mechanical',
  decision: 'Decision',
  user_action: 'Yours',
  unclassified: 'Needs triage',
}

/** A codicon per kind — the glyph column in §B5.1. */
export const KIND_ICONS: Record<BoardItemKind, string> = {
  mechanical: 'gear',
  decision: 'git-branch',
  user_action: 'account',
  unclassified: 'question',
}

export function isBoardItemKind(v: unknown): v is BoardItemKind {
  return typeof v === 'string' && (BOARD_KINDS as string[]).includes(v)
}

/**
 * Text → key, so the same item keeps its board state across a re-analysis that
 * did not reword it (B4). Deliberately exact after normalisation: a reworded
 * item reappears as new work rather than silently inheriting a state it never
 * earned (B5).
 */
export function normaliseItemText(text: string): string {
  return text
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;,:!?\s]+$/, '')
    .trim()
    .toLowerCase()
}

/**
 * FNV-1a twice with different offsets → 12 hex chars. Pure JS on purpose: this
 * module is imported by the webview, where `node:crypto` does not exist.
 */
export function itemIdOf(text: string): string {
  const s = normaliseItemText(text)
  return `${fnv1a(s, 0x811c9dc5)}${fnv1a(s, 0x01000193).slice(0, 4)}`
}

function fnv1a(s: string, offset: number): string {
  let h = offset >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** `${sessionId}:${itemId}` — the `board.json` key (B3.2). */
export function boardKey(sessionId: string, itemId: string): string {
  return `${sessionId}:${itemId}`
}

/**
 * The strings are canonical; the model's `items[]` only annotates them (B3).
 *
 * Every `next_step` then every `blocker` produces exactly one ReviewItem, in
 * order. A string with no matching annotation becomes `unclassified` — which is
 * shown as needs-triage and is never eligible for automation — and annotations
 * matching no string are dropped. A model that paraphrases, invents or drops
 * entries therefore cannot change what work exists, only how well it is tagged.
 */
export function reconcileItems(
  nextSteps: string[],
  blockers: string[],
  annotations: readonly Partial<ReviewItem>[]
): ReviewItem[] {
  const byText = new Map<string, Partial<ReviewItem>>()
  for (const a of annotations) {
    if (typeof a.text !== 'string') continue
    const key = normaliseItemText(a.text)
    if (key && !byText.has(key)) byText.set(key, a)
  }
  const out: ReviewItem[] = []
  const seen = new Set<string>()
  const add = (text: string, source: BoardItemSource) => {
    const key = normaliseItemText(text)
    if (!key || seen.has(key)) return // a list that repeats itself yields one row
    seen.add(key)
    const hit = byText.get(key)
    out.push({
      id: itemIdOf(text),
      text,
      source,
      kind: isBoardItemKind(hit?.kind) ? hit.kind : 'unclassified',
      effort: isEffort(hit?.effort) ? hit.effort : null,
    })
  }
  for (const t of nextSteps) add(t, 'next_step')
  for (const t of blockers) add(t, 'blocker')
  return out
}

function isEffort(v: unknown): v is BoardItemEffort {
  return v === 'small' || v === 'medium' || v === 'large'
}

/**
 * Reports written before B1 carry no `items[]`. Rather than render a blank
 * board for them, derive unclassified rows from the strings they do have; the
 * report is separately marked out of date (B9), so one Analyse fixes the tags.
 */
export function itemsOf(
  review: Pick<ChatReview, 'items' | 'next_steps' | 'blockers'>
): ReviewItem[] {
  if (review.items && review.items.length) return review.items
  return reconcileItems(review.next_steps, review.blockers, [])
}

/**
 * The prompt for two or more items of one session (§B6). A single item keeps
 * `promptForItem` from shared/review.ts unchanged. Seeded, never sent (D9).
 */
export function promptForItems(texts: string[]): string {
  const list = texts.map((t, i) => `${i + 1}. ${t.trim()}`).join('\n')
  return [
    'Work through these items from our last review of this session:',
    '',
    list,
    '',
    'Do the straightforward parts yourself. If any of them needs a decision that would fork the work, stop and ask me before doing it. When you are done, summarise what changed and what still remains.',
  ].join('\n')
}
