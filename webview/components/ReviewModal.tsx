import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { FavoriteGroup } from '../../src/shared/cards'
import { formatTimeDistance } from '../../src/shared/cards'
import type { ReviewState } from '../../src/shared/messages'
import type { BatchProgress, ChatReview, ReviewStatus } from '../../src/shared/review'
import { post } from '../vscodeApi'
import { Modal } from './Modal'

interface Props {
  group: FavoriteGroup | undefined
  review: ReviewState
  focus: string | null
  onClose: () => void
}

interface Row {
  id: string
  title: string
  subtitle: string | null
  preview: string | null
  updatedAt: string | null
  favorited: boolean
  missing: boolean
  review: (ChatReview & { stale: boolean }) | undefined
  status: ReviewStatus | undefined
  error: string | undefined
}

/**
 * The Review modal (spec §9). Every starred session is listed whether or not
 * it has a report (Snippbot #850); reviewed ones sort by priority, unreviewed
 * ones sort below by recency, so the ranking is never muddied. The header is
 * pinned — status, Analyse, cost, and the batch progress bar with per-session
 * state — and the cards own their own scroll region (#852).
 */
export function ReviewModal({ group, review, focus, onClose }: Props) {
  const batch = review.batch
  const running = batch?.running ?? false

  const rows = useMemo(() => buildRows(group, review), [group, review])
  const reviewedCount = rows.filter((r) => r.review).length
  const staleCount = rows.filter((r) => r.review?.stale).length
  const unreviewed = rows.filter((r) => !r.review && !r.missing)
  const pending = rows.filter((r) => !r.missing && (!r.review || r.review.stale)).map((r) => r.id)

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focus) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-session-id="${CSS.escape(focus)}"]`
    )
    el?.scrollIntoView({ block: 'start' })
  }, [focus, rows.length])

  const analyse = (ids: string[] | null, force: boolean) =>
    post({ type: 'reviewAnalyze', ids, force })

  return (
    <Modal title="Review sessions" onClose={onClose} width="full">
      <div class="review__head">
        <div class="review__status">
          <strong>{rows.length}</strong> starred · <strong>{reviewedCount}</strong> reviewed
          {staleCount ? (
            <>
              {' '}
              · <strong>{staleCount}</strong> out of date
            </>
          ) : null}
          {unreviewed.length ? (
            <>
              {' '}
              · <strong>{unreviewed.length}</strong> unreviewed
            </>
          ) : null}
        </div>
        <div class="review__actions">
          {running ? (
            <button class="button" type="button" onClick={() => post({ type: 'reviewCancel' })}>
              <span class="codicon codicon-stop-circle" aria-hidden="true" /> Cancel
            </button>
          ) : (
            <>
              <button
                class="button button--primary"
                type="button"
                disabled={pending.length === 0 || !review.cli.found}
                onClick={() => analyse(pending, false)}
                title={
                  review.cli.found ? undefined : 'No claude CLI found — set sessionDeck.claudePath'
                }
              >
                <span class="codicon codicon-play" aria-hidden="true" /> Analyse {pending.length}{' '}
                session
                {pending.length === 1 ? '' : 's'}
              </button>
              <button
                class="button"
                type="button"
                disabled={rows.filter((r) => !r.missing).length === 0 || !review.cli.found}
                onClick={() => analyse(null, true)}
              >
                Re-analyse all
              </button>
            </>
          )}
        </div>
        <p class="review__note muted">
          Analysing reads each session's recent transcript and costs one model call per session (
          {review.model}). Reports are kept until the session moves on.
          {batch && !running && batch.ids.length
            ? ` Last batch: $${batch.cost_usd.toFixed(3)}.`
            : ''}
          {!review.cli.found ? ' No claude CLI was found — set sessionDeck.claudePath.' : ''}
        </p>
        {batch && batch.ids.length ? (
          <ProgressBar batch={batch} titles={new Map(rows.map((r) => [r.id, r.title]))} />
        ) : null}
      </div>

      <div class="review__list" ref={listRef}>
        {rows.length === 0 ? (
          <p class="muted">Nothing to review yet — star a session first.</p>
        ) : (
          rows.map((row) =>
            row.review ? (
              <ReviewCard key={row.id} row={row} />
            ) : (
              <UnreviewedCard key={row.id} row={row} running={running} />
            )
          )
        )}
      </div>
    </Modal>
  )
}

function buildRows(group: FavoriteGroup | undefined, review: ReviewState): Row[] {
  const rows: Row[] = []
  const status = review.batch?.status ?? {}
  const errors = review.batch?.errors ?? {}
  const seen = new Set<string>()
  for (const item of group?.items ?? []) {
    seen.add(item.entityId)
    rows.push({
      id: item.entityId,
      title: item.card?.title ?? item.label,
      subtitle: item.card?.subtitle ?? null,
      preview: item.card?.preview ?? null,
      updatedAt: item.card?.updatedAt ?? null,
      favorited: true,
      missing: item.missing,
      review: review.reviews[item.entityId],
      status: status[item.entityId],
      error: errors[item.entityId],
    })
  }
  for (const id of review.extraIds) {
    if (seen.has(id)) continue
    const card = review.extraCards[id]
    rows.push({
      id,
      title: card?.title ?? review.reviews[id]?.title ?? id,
      subtitle: card?.subtitle ?? null,
      preview: card?.preview ?? null,
      updatedAt: card?.updatedAt ?? null,
      favorited: false,
      missing: !card,
      review: review.reviews[id],
      status: status[id],
      error: errors[id],
    })
  }
  // Most urgent first; unreviewed and missing sort below by recency so a
  // missing priority never outranks a real one.
  return rows.sort((a, b) => {
    const pa = a.review?.priority ?? -1
    const pb = b.review?.priority ?? -1
    if (pa !== pb) return pb - pa
    return (b.updatedAt ?? '') < (a.updatedAt ?? '') ? -1 : 1
  })
}

function ProgressBar({ batch, titles }: { batch: BatchProgress; titles: Map<string, string> }) {
  const total = batch.ids.length
  const finished =
    batch.done +
    batch.failed +
    (batch.cancelled ? batch.ids.filter((id) => batch.status[id] === 'cancelled').length : 0)
  const pct = total ? Math.round((finished / total) * 100) : 0
  const runningIds = batch.ids.filter((id) => batch.status[id] === 'running')
  const label = batch.running
    ? `Analysing ${finished + runningIds.length} of ${total}${runningIds.length ? ` — ${runningIds.map((id) => titles.get(id) ?? id).join(', ')}` : ''}`
    : batch.cancelled
      ? `Cancelled after ${batch.done} of ${total}`
      : `Done: ${batch.done} of ${total}${batch.failed ? `, ${batch.failed} failed` : ''}`
  return (
    <div class="progress" role="group" aria-label="Analysis progress">
      <div
        class="progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <div
          class={`progress__fill${batch.failed ? ' progress__fill--warn' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div class="progress__label" aria-live="polite">
        {label}
      </div>
      <ul class="progress__items" aria-label="Per-session status">
        {batch.ids.map((id) => (
          <li
            class={`progress__item progress__item--${batch.status[id] ?? 'queued'}`}
            key={id}
            title={batch.errors[id]}
          >
            <span
              class={`codicon codicon-${statusIcon(batch.status[id])}${batch.status[id] === 'running' ? ' codicon-modifier-spin' : ''}`}
              aria-hidden="true"
            />
            <span class="progress__item-title">{titles.get(id) ?? id}</span>
            {batch.errors[id] ? <span class="progress__item-error">{batch.errors[id]}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function statusIcon(status: ReviewStatus | undefined): string {
  switch (status) {
    case 'running':
      return 'loading'
    case 'done':
      return 'check'
    case 'failed':
      return 'error'
    case 'cancelled':
      return 'circle-slash'
    case 'queued':
    case undefined:
      return 'circle-outline'
  }
}

function ReviewCard({ row }: { row: Row }) {
  const r = row.review!
  const [choice, setChoice] = useState<string>(r.options[0]?.id ?? '')
  const chosen = r.options.find((o) => o.id === choice)
  // Default target: the panel for this workspace's sessions, a new window
  // otherwise. The dashboard is its own tab, so the modal survives either way.
  const open = (prompt?: string) =>
    post({ type: 'open', entityType: 'session', entityId: row.id, ...(prompt ? { prompt } : {}) })
  return (
    <article
      class={`rcard rcard--p${r.priority}${row.status === 'running' ? ' rcard--busy' : ''}`}
      data-session-id={row.id}
      aria-label={row.title}
    >
      <header class="rcard__head">
        <div class="rcard__title-wrap">
          <span class={`prio prio--${r.priority}`} title={r.priority_reason}>
            {r.priority} · {r.priority_label}
          </span>
          <h3 class="rcard__title">{row.title}</h3>
          {r.stale ? (
            <span class="tag tag--warn" title="The transcript has moved on since this report">
              out of date
            </span>
          ) : null}
          {row.status === 'running' ? <span class="tag">analysing…</span> : null}
          {!row.favorited ? <span class="tag">not starred</span> : null}
        </div>
        <div class="rcard__meta muted">
          {row.subtitle ? `${row.subtitle} · ` : ''}
          {formatTimeDistance(row.updatedAt)}
        </div>
      </header>
      {row.error ? <p class="rcard__error">Last attempt failed: {row.error}</p> : null}
      <p class="rcard__summary">{r.summary}</p>
      <p class="rcard__why muted">{r.priority_reason}</p>
      <div class="rcard__cols">
        <List title="Done" items={r.done} icon="check" empty="Nothing recorded as done." />
        <List
          title="Still to do"
          items={r.next_steps}
          icon="circle-large-outline"
          empty="Nothing outstanding."
        />
        <List title="Blocked on" items={r.blockers} icon="warning" empty="No blockers." />
      </div>
      {r.options.length ? (
        <fieldset class="directions">
          <legend class="directions__legend">Recommended directions</legend>
          {r.options.map((o) => (
            <label class={`direction${choice === o.id ? ' direction--on' : ''}`} key={o.id}>
              <input
                type="radio"
                name={`dir-${row.id}`}
                value={o.id}
                checked={choice === o.id}
                onChange={() => setChoice(o.id)}
              />
              <span class="direction__text">
                <span class="direction__label">{o.label}</span>
                <span class="direction__desc muted">{o.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <footer class="rcard__actions">
        <button
          class="button button--primary"
          type="button"
          disabled={!chosen}
          onClick={() => open(chosen?.prompt)}
          title="Opens the session with this prompt typed into the composer — not sent"
        >
          <span class="codicon codicon-arrow-right" aria-hidden="true" /> Take this direction
        </button>
        <button class="button" type="button" onClick={() => open()}>
          Open
        </button>
        <button
          class="button"
          type="button"
          onClick={() => post({ type: 'reviewAnalyze', ids: [row.id], force: true })}
          disabled={row.status === 'running'}
        >
          Re-analyse
        </button>
        {row.favorited ? (
          <button
            class="button"
            type="button"
            onClick={() =>
              post({
                type: 'toggleFavorite',
                entityType: 'session',
                entityId: row.id,
                label: row.title,
              })
            }
          >
            <span class="codicon codicon-star-full" aria-hidden="true" /> Remove from favorites
          </button>
        ) : (
          <button
            class="button"
            type="button"
            onClick={() => post({ type: 'reviewDismissExtra', sessionId: row.id })}
          >
            Dismiss
          </button>
        )}
        <span class="rcard__footnote muted">
          {r.model} · {formatTimeDistance(r.analyzed_at)}
          {typeof r.cost_usd === 'number' ? ` · $${r.cost_usd.toFixed(3)}` : ''}
        </span>
      </footer>
    </article>
  )
}

function UnreviewedCard({ row, running }: { row: Row; running: boolean }) {
  const busy = row.status === 'running' || row.status === 'queued'
  return (
    <article
      class={`rcard rcard--unreviewed${row.missing ? ' rcard--missing' : ''}`}
      data-session-id={row.id}
      aria-label={row.title}
    >
      <header class="rcard__head">
        <div class="rcard__title-wrap">
          <h3 class="rcard__title">{row.title}</h3>
          {row.missing ? <span class="tag tag--warn">no longer on disk</span> : null}
          {!row.favorited ? <span class="tag">not starred</span> : null}
        </div>
        <div class="rcard__meta muted">
          {row.subtitle ? `${row.subtitle} · ` : ''}
          {formatTimeDistance(row.updatedAt)}
        </div>
      </header>
      {row.preview ? <p class="rcard__summary muted">{row.preview}</p> : null}
      {row.error ? <p class="rcard__error">Analysis failed: {row.error}</p> : null}
      <footer class="rcard__actions">
        {row.missing ? (
          <p class="muted">This session's transcript is gone; there is nothing to review.</p>
        ) : (
          <>
            <p class="rcard__cta-text">
              {busy
                ? row.status === 'running'
                  ? 'Analysing…'
                  : 'Queued…'
                : row.error
                  ? 'Not reviewed — try again.'
                  : 'Not reviewed yet.'}
            </p>
            <button
              class="button button--primary button--big"
              type="button"
              disabled={busy || running}
              onClick={() => post({ type: 'reviewAnalyze', ids: [row.id], force: true })}
            >
              <span class="codicon codicon-play" aria-hidden="true" />{' '}
              {row.error ? 'Retry' : 'Review this session'}
            </button>
          </>
        )}
        {row.favorited ? (
          <button
            class="button"
            type="button"
            onClick={() =>
              post({
                type: 'toggleFavorite',
                entityType: 'session',
                entityId: row.id,
                label: row.title,
              })
            }
          >
            Remove from favorites
          </button>
        ) : (
          <button
            class="button"
            type="button"
            onClick={() => post({ type: 'reviewDismissExtra', sessionId: row.id })}
          >
            Dismiss
          </button>
        )}
      </footer>
    </article>
  )
}

function List({
  title,
  items,
  icon,
  empty,
}: {
  title: string
  items: string[]
  icon: string
  empty: string
}) {
  return (
    <section class="rlist">
      <h4 class="rlist__title">
        <span class={`codicon codicon-${icon}`} aria-hidden="true" /> {title}
      </h4>
      {items.length ? (
        <ul class="rlist__items">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : (
        <p class="muted rlist__empty">{empty}</p>
      )}
    </section>
  )
}
