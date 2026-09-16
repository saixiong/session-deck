import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReviewItem } from '../../src/shared/board'
import { itemIdOf } from '../../src/shared/board'
import type { BoardRow, BoardState, DashboardPrefs } from '../../src/shared/messages'
import { DEFAULT_PREFS } from '../../src/shared/messages'
import { posted } from '../test/setup'
import { BoardView } from './BoardView'

beforeEach(() => {
  posted.length = 0
})
afterEach(() => cleanup())

const item = (text: string, kind: ReviewItem['kind'], source: ReviewItem['source'] = 'next_step') =>
  ({ id: itemIdOf(text), text, kind, source, effort: 'small' }) satisfies ReviewItem

const row = (sessionId: string, title: string, it: ReviewItem, state: BoardRow['state'] = null) =>
  ({
    sessionId,
    sessionTitle: title,
    project: 'snippbot',
    priority: 4,
    priorityLabel: 'High',
    completion: 70,
    stale: false,
    item: it,
    state,
  }) satisfies BoardRow

const MERGE = item('Merge PR #42', 'mechanical')
const DECIDE = item('Decide whether to fix the frost bug', 'decision')
const PUSH = item('Push your local commits', 'user_action')
const CI = item('CI is red on main', 'decision', 'blocker')

const board = (rows: BoardRow[], unreviewed = 0): BoardState => ({ rows, unreviewed })
const prefs = (patch: Partial<DashboardPrefs> = {}): DashboardPrefs => ({
  ...DEFAULT_PREFS,
  mode: 'board',
  ...patch,
})

describe('BoardView', () => {
  it('groups by session, counts by kind, and links the header to that session s review', () => {
    render(
      <BoardView
        board={board([
          row('s1', 'Release PRs', MERGE),
          row('s1', 'Release PRs', DECIDE),
          row('s2', 'Dashboard audit', PUSH),
        ])}
        prefs={prefs()}
        onReview={() => undefined}
      />
    )
    const groups = document.querySelectorAll('.board__group')
    expect(groups).toHaveLength(2)
    expect(within(groups[0] as HTMLElement).getAllByRole('listitem')).toHaveLength(2)
    const status = document.querySelector('.board__status')!.textContent.replace(/\s+/g, ' ')
    expect(status).toContain('3 open')
    expect(status).toContain('1 mechanical')
    expect(status).toContain('1 decision')
    expect(status).toContain('1 yours')
  })

  it('filters by kind and hides closed rows until Show done', () => {
    const rows = [row('s1', 'A', MERGE), row('s1', 'A', DECIDE), row('s1', 'A', PUSH, 'done')]
    const { rerender } = render(
      <BoardView board={board(rows)} prefs={prefs()} onReview={() => undefined} />
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('Push your local commits')).toBeNull()

    rerender(
      <BoardView
        board={board(rows)}
        prefs={prefs({ boardKinds: ['mechanical'] })}
        onReview={() => undefined}
      />
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Merge PR #42')).toBeTruthy()

    rerender(
      <BoardView
        board={board(rows)}
        prefs={prefs({ boardShowClosed: true })}
        onReview={() => undefined}
      />
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    // A closed row is counted out of "open" either way.
    expect(document.querySelector('.board__status')!.textContent).toContain('2 open')
  })

  it('a filter chip and Show done are prefs, not local state', () => {
    render(
      <BoardView
        board={board([row('s1', 'A', MERGE)])}
        prefs={prefs()}
        onReview={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Mechanical/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Show done' }))
    expect(posted).toEqual([
      { type: 'setPrefs', prefs: { boardKinds: ['mechanical'] } },
      { type: 'setPrefs', prefs: { boardShowClosed: true } },
    ])
  })

  it('selecting across sessions gives one seed entry per session, in board order', () => {
    render(
      <BoardView
        board={board([
          row('s1', 'Release PRs', MERGE),
          row('s1', 'Release PRs', CI),
          row('s2', 'Dashboard audit', DECIDE),
        ])}
        prefs={prefs()}
        onReview={() => undefined}
      />
    )
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    expect(document.querySelector('.board__bulk-count')!.textContent).toContain('3 selected')
    const entries = document.querySelectorAll('.board__queue-item')
    expect(entries).toHaveLength(2)
    fireEvent.click(within(entries[0] as HTMLElement).getByText('Seed'))
    expect(posted).toEqual([
      {
        type: 'boardSeed',
        sessionId: 's1',
        items: [
          { itemId: MERGE.id, text: MERGE.text },
          { itemId: CI.id, text: CI.text },
        ],
      },
    ])
    // Copy sends the same payload, flagged so the host never opens anything.
    posted.length = 0
    fireEvent.click(within(entries[1] as HTMLElement).getByLabelText(/Copy prompt/))
    expect(posted[0]).toMatchObject({ type: 'boardSeed', sessionId: 's2', copyOnly: true })
  })

  it('bulk Done and per-row Done both post boardSetState; Done toggles back to Reopen', () => {
    const { rerender } = render(
      <BoardView
        board={board([row('s1', 'A', MERGE)])}
        prefs={prefs()}
        onReview={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: `Mark done: ${MERGE.text}` }))
    expect(posted[0]).toEqual({
      type: 'boardSetState',
      items: [{ sessionId: 's1', itemId: MERGE.id, text: MERGE.text }],
      state: 'done',
    })
    posted.length = 0
    rerender(
      <BoardView
        board={board([row('s1', 'A', MERGE, 'done')])}
        prefs={prefs({ boardShowClosed: true })}
        onReview={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: `Reopen: ${MERGE.text}` }))
    expect(posted[0]).toMatchObject({ state: null })
  })

  it('a single row seeds only itself', () => {
    render(
      <BoardView
        board={board([row('s1', 'A', MERGE)])}
        prefs={prefs()}
        onReview={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: `Do this: ${MERGE.text}` }))
    expect(posted).toEqual([
      { type: 'boardSeed', sessionId: 's1', items: [{ itemId: MERGE.id, text: MERGE.text }] },
    ])
  })

  it('says what to do when there is nothing on it', () => {
    const { rerender } = render(
      <BoardView board={board([], 0)} prefs={prefs()} onReview={() => undefined} />
    )
    expect(screen.getByText(/Star a session and review it/)).toBeTruthy()
    rerender(<BoardView board={board([], 3)} prefs={prefs()} onReview={() => undefined} />)
    expect(screen.getByText(/analyse your starred sessions/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /3 sessions not reviewed yet/ })).toBeTruthy()
    rerender(
      <BoardView
        board={board([row('s1', 'A', MERGE)])}
        prefs={prefs({ boardKinds: ['decision'] })}
        onReview={() => undefined}
      />
    )
    expect(screen.getByText('Nothing matches these filters.')).toBeTruthy()
  })
})
