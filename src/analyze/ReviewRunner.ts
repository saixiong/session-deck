import { resolveTitle } from '../index/records'
import type { SessionIndexEntry } from '../index/types'
import type { BatchProgress, ChatReview } from '../shared/review'
import type { CliResult } from './ClaudeCli'
import type { ReviewStore } from './ReviewStore'
import { fingerprintOf } from './ReviewStore'
import { emptyReview, makeReview, parseReview, REVIEW_SCHEMA, SYSTEM_PROMPT } from './schema'
import type { Transcript } from './transcript'

/**
 * Batch orchestration (spec §9.3). Concurrency-limited, cancellable,
 * per-session failure isolation (Chat Review D5): one unreadable session
 * cannot lose the batch, and its error is reported inline. Failed reviews
 * live only in the batch state — never in the store (D4).
 *
 * No vscode imports: the extension supplies the CLI call and the transcript
 * builder, so the runner is unit-testable with fakes that mimic the recorded
 * result shape.
 */
export const MAX_REVIEW_IDS = 50

export interface RunnerDeps {
  getEntry(sessionId: string): SessionIndexEntry | undefined
  buildTranscript(entry: SessionIndexEntry): Promise<Transcript>
  callModel(args: {
    prompt: string
    systemPrompt: string
    schema: object
    signal: AbortSignal
  }): Promise<CliResult>
  store: ReviewStore
  model: string
  concurrency: number
  log?: (message: string) => void
}

export type ProgressListener = (progress: BatchProgress) => void

export class ReviewRunner {
  private progress: BatchProgress | null = null
  private abort: AbortController | null = null
  private readonly listeners = new Set<ProgressListener>()

  constructor(private readonly deps: RunnerDeps) {}

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  current(): BatchProgress | null {
    return this.progress
  }

  get running(): boolean {
    return this.progress?.running ?? false
  }

  /** A cached review is stale once the transcript has moved (Chat Review D3). */
  isStale(review: ChatReview, entry: SessionIndexEntry | undefined): boolean {
    return !entry || entry.missing || fingerprintOf(entry) !== review.fingerprint
  }

  /**
   * Analyse `ids` (deduplicated, capped). Cached-and-fresh ids are skipped
   * unless `force`. Resolves when the batch finishes or is cancelled; the
   * progress object is the source of truth for the UI throughout.
   */
  async analyze(requested: string[], opts: { force?: boolean } = {}): Promise<BatchProgress> {
    if (this.running) throw new Error('a review batch is already running')
    const ids = [...new Set(requested)].slice(0, MAX_REVIEW_IDS)
    const work = ids.filter((id) => {
      if (opts.force) return true
      const cached = this.deps.store.get(id)
      return !cached || this.isStale(cached, this.deps.getEntry(id))
    })
    const progress: BatchProgress = {
      ids: work,
      status: Object.fromEntries(work.map((id) => [id, 'queued'])),
      errors: {},
      done: 0,
      failed: 0,
      running: work.length > 0,
      cancelled: false,
      cost_usd: 0,
      started_at: new Date().toISOString(),
      finished_at: work.length > 0 ? null : new Date().toISOString(),
    }
    this.progress = progress
    this.abort = new AbortController()
    this.emit()
    if (work.length === 0) return progress

    const signal = this.abort.signal
    let next = 0
    const worker = async () => {
      while (next < work.length && !signal.aborted) {
        const id = work[next++]!
        progress.status[id] = 'running'
        this.emit()
        try {
          const review = await this.reviewOne(id, signal)
          progress.cost_usd += review.cost_usd ?? 0
          progress.status[id] = 'done'
          progress.done++
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          progress.status[id] = signal.aborted ? 'cancelled' : 'failed'
          if (!signal.aborted) {
            progress.errors[id] = message
            progress.failed++
          }
          this.deps.log?.(`review ${id}: ${message}`)
        }
        this.emit()
      }
    }
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(this.deps.concurrency, work.length)) }, worker)
    )
    for (const id of work) if (progress.status[id] === 'queued') progress.status[id] = 'cancelled'
    progress.running = false
    progress.cancelled = signal.aborted
    progress.finished_at = new Date().toISOString()
    this.emit()
    this.abort = null
    return progress
  }

  cancel(): void {
    this.abort?.abort()
  }

  private async reviewOne(id: string, signal: AbortSignal): Promise<ChatReview> {
    const entry = this.deps.getEntry(id)
    if (!entry || entry.missing) throw new Error('transcript is no longer on disk')
    const base = {
      conversation_id: id,
      title: resolveTitle(entry),
      model: this.deps.model,
      fingerprint: fingerprintOf(entry),
      message_count: entry.messageCount,
      cost_usd: null as number | null,
      duration_ms: null as number | null,
    }
    const transcript = await this.deps.buildTranscript(entry)
    if (transcript.turns === 0) {
      const review = emptyReview(base)
      await this.deps.store.set(review)
      return review
    }
    // Race the call against cancellation: the CLI wrapper honours the signal,
    // but the batch must not hang on a callee that does not.
    const result = await Promise.race([
      this.deps.callModel({
        prompt: transcript.text,
        systemPrompt: SYSTEM_PROMPT,
        schema: REVIEW_SCHEMA,
        signal,
      }),
      new Promise<CliResult>((_, reject) => {
        const onAbort = () => reject(new Error('cancelled'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    if (!result.ok) throw new Error(result.errorText ?? 'the model call failed')
    const parsed = parseReview(result.structured, result.resultText)
    const review = makeReview(
      { ...base, cost_usd: result.costUsd, duration_ms: result.durationMs },
      parsed
    )
    await this.deps.store.set(review)
    return review
  }

  private emit(): void {
    if (!this.progress) return
    const snapshot: BatchProgress = {
      ...this.progress,
      status: { ...this.progress.status },
      errors: { ...this.progress.errors },
    }
    for (const l of this.listeners) {
      try {
        l(snapshot)
      } catch {
        // a listener must not break the batch
      }
    }
  }
}
