/**
 * The review report shape (spec §4.2, D7): identical to Snippbot's
 * `ChatReview`, so reports from the two tools are interchangeable. Shared by
 * host and webview — no vscode or Node imports.
 */
export const MIN_PRIORITY = 1
export const MAX_PRIORITY = 5
export const DEFAULT_PRIORITY = 3

export const PRIORITY_LABELS: Record<number, string> = {
  5: 'Critical',
  4: 'High',
  3: 'Medium',
  2: 'Low',
  1: 'Idle',
}

export interface ReviewOption {
  id: string
  label: string
  description: string
  /** Seeded into the composer when chosen — written as an instruction to the agent. */
  prompt: string
}

export interface ChatReview {
  conversation_id: string
  title: string
  summary: string
  done: string[]
  next_steps: string[]
  blockers: string[]
  priority: number
  priority_label: string
  priority_reason: string
  /**
   * 0–100: how much of what the session set out to do is done and verified.
   * `null` on reports written before the score existed; never guessed.
   */
  completion: number | null
  completion_reason: string
  options: ReviewOption[]
  model: string
  analyzed_at: string
  /** `${messageCount}:${lastActiveAt}` — the staleness signal (Chat Review D3). */
  fingerprint: string
  message_count: number
  cost_usd: number | null
  duration_ms: number | null
  error: string | null
}

export type ReviewStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface BatchProgress {
  /** Session ids in the order they were queued. */
  ids: string[]
  status: Record<string, ReviewStatus>
  errors: Record<string, string>
  done: number
  failed: number
  running: boolean
  cancelled: boolean
  cost_usd: number
  started_at: string
  finished_at: string | null
}

/** Coerce a model-supplied priority into the band; garbage lands in the middle, never at the top. */
export function clampPriority(value: unknown): number {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  if (!Number.isFinite(n)) return DEFAULT_PRIORITY
  return Math.max(MIN_PRIORITY, Math.min(MAX_PRIORITY, Math.round(n)))
}

export function priorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority] ?? PRIORITY_LABELS[DEFAULT_PRIORITY]!
}

/** 0–100 from whatever the model or an old file supplied; anything unusable is "unknown", not 0. */
export function clampCompletion(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n)))
}

export type ReviewItemKind = 'next_step' | 'blocker'

/**
 * The prompt seeded when the user picks one "Still to do" or "Blocked on"
 * item to act on. A template rather than a model-written prompt: it costs
 * nothing, and the item text is the model's own wording of the work.
 */
export function promptForItem(kind: ReviewItemKind, text: string): string {
  const item = text.trim()
  return kind === 'blocker'
    ? `Resolve this blocker before anything else: ${item}\n\nIf it needs a decision from me, ask; otherwise fix it and report what changed.`
    : `Pick up where we left off and do this next step: ${item}\n\nWhen it is done, summarise what changed and what remains.`
}
