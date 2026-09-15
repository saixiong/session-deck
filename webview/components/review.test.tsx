import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavoriteCard, FavoriteGroup, FavoriteItem } from '../../src/shared/cards'
import type { ReviewState } from '../../src/shared/messages'
import type { BatchProgress, ChatReview } from '../../src/shared/review'
import { posted } from '../test/setup'
import { ReviewModal } from './ReviewModal'

beforeEach(() => {
  posted.length = 0
})
afterEach(() => cleanup())

const card = (id: string, title: string): FavoriteCard => ({
  entityType: 'session',
  entityId: id,
  title,
  subtitle: 'proj · main',
  preview: `preview of ${title}`,
  details: [],
  status: null,
  statusVariant: null,
  updatedAt: '2026-09-14T10:00:00Z',
  group: { key: '/w/proj', label: 'proj' },
  meta: {},
})

const item = (id: string, title: string, missing = false): FavoriteItem => ({
  id: `fav_${id}`,
  entityType: 'session',
  entityId: id,
  label: title,
  note: null,
  sortOrder: 1,
  createdAt: '',
  card: missing ? null : card(id, title),
  missing,
})

const review = (
  id: string,
  priority: number,
  extra: Partial<ChatReview & { stale: boolean }> = {}
): ChatReview & { stale: boolean } => ({
  conversation_id: id,
  title: `t-${id}`,
  summary: `summary ${id}`,
  done: ['did a thing'],
  next_steps: ['do the next thing'],
  blockers: [],
  priority,
  priority_label: 'x',
  priority_reason: `because ${id}`,
  completion: 60,
  completion_reason: `sixty because ${id}`,
  options: [
    { id: 'one', label: 'Option one', description: 'first', prompt: `PROMPT ONE ${id}` },
    { id: 'two', label: 'Option two', description: 'second', prompt: `PROMPT TWO ${id}` },
  ],
  model: 'sonnet',
  analyzed_at: '2026-09-14T09:00:00Z',
  fingerprint: '1:x',
  message_count: 1,
  cost_usd: 0.012,
  duration_ms: 1000,
  error: null,
  stale: false,
  ...extra,
})

const group = (items: FavoriteItem[]): FavoriteGroup => ({
  entityType: 'session',
  label: 'Sessions',
  icon: 'x',
  items,
})

const state = (overrides: Partial<ReviewState> = {}): ReviewState => ({
  reviews: {},
  batch: null,
  extraIds: [],
  extraCards: {},
  model: 'sonnet',
  cli: { found: true, path: '/x/claude', source: 'path' },
  ...overrides,
})

describe('ReviewModal', () => {
  it('lists every starred session: reviewed by priority first, then unreviewed with a big Review button', () => {
    render(
      <ReviewModal
        group={group([
          item('low', 'Low one'),
          item('hi', 'High one'),
          item('new', 'Never reviewed'),
          item('gone', 'Gone one', true),
        ])}
        review={state({ reviews: { low: review('low', 2), hi: review('hi', 5) } })}
        focus={null}
        onClose={() => undefined}
      />
    )
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(titles).toEqual(['High one', 'Low one', 'Never reviewed', 'Gone one'])
    expect(screen.getByText('Review this session')).toBeTruthy()
    const status = document.querySelector('.review__status')!.textContent.replace(/\s+/g, ' ')
    expect(status).toContain('4 starred')
    expect(status).toContain('2 reviewed')
    expect(status).toContain('1 unreviewed')
    expect(status).toContain('60% complete on average')
    // Analyse covers the unreviewed one only (fresh reviews are not pending; the missing one cannot run).
    expect(screen.getByText(/Analyse 1 session/)).toBeTruthy()
    expect(screen.getByText(/no longer on disk/)).toBeTruthy()
  })

  it('directions are a radio group; Take this direction opens with the chosen prompt, never sends', () => {
    render(
      <ReviewModal
        group={group([item('a', 'A')])}
        review={state({ reviews: { a: review('a', 4) } })}
        focus={null}
        onClose={() => undefined}
      />
    )
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect((radios[0] as HTMLInputElement).checked).toBe(true)
    fireEvent.click(radios[1]!)
    fireEvent.click(screen.getByText('Take this direction'))
    expect(posted).toEqual([
      { type: 'open', entityType: 'session', entityId: 'a', prompt: 'PROMPT TWO a' },
    ])
    fireEvent.click(screen.getByText('Remove from favorites'))
    expect(posted[1]).toEqual({
      type: 'toggleFavorite',
      entityType: 'session',
      entityId: 'a',
      label: 'A',
    })
    fireEvent.click(screen.getByText('Re-analyse'))
    expect(posted[2]).toEqual({ type: 'reviewAnalyze', ids: ['a'], force: true })
  })

  it('shows the completion score as a meter, and hides it on reports that predate it', () => {
    render(
      <ReviewModal
        group={group([item('a', 'A'), item('b', 'B')])}
        review={state({
          reviews: {
            a: review('a', 4, { completion: 92, completion_reason: 'verified, docs left' }),
            b: review('b', 3, { completion: null, completion_reason: '' }),
          },
        })}
        focus={null}
        onClose={() => undefined}
      />
    )
    const meters = screen.getAllByRole('meter')
    expect(meters).toHaveLength(1)
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('92')
    expect(meters[0]!.getAttribute('title')).toBe('verified, docs left')
    expect(meters[0]!.className).toContain('score--high')
    expect(document.querySelector('.review__status')!.textContent).toContain('92% complete')
  })

  it('each "Still to do" and "Blocked on" item opens the session with a prompt for just that item', () => {
    render(
      <ReviewModal
        group={group([item('a', 'A')])}
        review={state({
          reviews: {
            a: review('a', 4, {
              next_steps: ['Merge PR #42', 'Update the changelog'],
              blockers: ['CI is red on main'],
            }),
          },
        })}
        focus={null}
        onClose={() => undefined}
      />
    )
    const doThis = screen.getAllByRole('button', { name: /^Do this:/ })
    expect(doThis.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Do this: Merge PR #42',
      'Do this: Update the changelog',
    ])
    fireEvent.click(doThis[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Fix this: CI is red on main' }))
    expect(posted).toHaveLength(2)
    expect(posted[0]).toMatchObject({ type: 'open', entityId: 'a' })
    expect((posted[0] as { prompt: string }).prompt).toContain('next step: Update the changelog')
    expect((posted[1] as { prompt: string }).prompt).toContain(
      'blocker before anything else: CI is red on main'
    )
    // "Done" items are not actionable.
    expect(screen.queryByRole('button', { name: /did a thing/ })).toBeNull()
  })

  it('Analyse sends the pending ids; the unreviewed card sends its own id forced', () => {
    render(
      <ReviewModal
        group={group([item('a', 'A'), item('b', 'B')])}
        review={state({ reviews: { a: review('a', 3, { stale: true }) } })}
        focus={null}
        onClose={() => undefined}
      />
    )
    expect(screen.getByText('out of date')).toBeTruthy()
    fireEvent.click(screen.getByText(/Analyse 2 sessions/))
    expect(posted[0]).toEqual({ type: 'reviewAnalyze', ids: ['a', 'b'], force: false })
    fireEvent.click(screen.getByText('Review this session'))
    expect(posted[1]).toEqual({ type: 'reviewAnalyze', ids: ['b'], force: true })
    fireEvent.click(screen.getByText('Re-analyse all'))
    expect(posted[2]).toEqual({ type: 'reviewAnalyze', ids: null, force: true })
  })

  it('shows the progress bar with per-session states and inline errors, and Cancel while running', () => {
    const batch: BatchProgress = {
      ids: ['a', 'b', 'c'],
      status: { a: 'done', b: 'running', c: 'failed' },
      errors: { c: 'Not logged in · Please run /login' },
      done: 1,
      failed: 1,
      running: true,
      cancelled: false,
      cost_usd: 0.01,
      started_at: '',
      finished_at: null,
    }
    render(
      <ReviewModal
        group={group([item('a', 'A'), item('b', 'B'), item('c', 'C')])}
        review={state({ reviews: { a: review('a', 3) }, batch })}
        focus={null}
        onClose={() => undefined}
      />
    )
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('67')
    expect(screen.getByText(/Analysing 3 of 3 — B/)).toBeTruthy()
    const items = within(screen.getByLabelText('Per-session status')).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[2]!.textContent).toContain('Not logged in')
    // The failed card carries the error inline and offers Retry.
    expect(screen.getByText(/Analysis failed: Not logged in/)).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    expect(posted).toEqual([{ type: 'reviewCancel' }])
    expect(screen.queryByText(/Analyse \d/)).toBeNull()
  })

  it('a non-favorite extra session is listed with Dismiss, and a missing CLI disables Analyse', () => {
    render(
      <ReviewModal
        group={group([])}
        review={state({
          extraIds: ['x'],
          extraCards: { x: card('x', 'Extra one') },
          reviews: { x: review('x', 3) },
          cli: { found: false, path: null, source: null },
        })}
        focus="x"
        onClose={() => undefined}
      />
    )
    expect(screen.getByText('Extra one')).toBeTruthy()
    expect(screen.getByText('not starred')).toBeTruthy()
    fireEvent.click(screen.getByText('Dismiss'))
    expect(posted[0]).toEqual({ type: 'reviewDismissExtra', sessionId: 'x' })
    expect(screen.getByText(/No claude CLI was found/)).toBeTruthy()
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(<ReviewModal group={group([])} review={state()} focus={null} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
