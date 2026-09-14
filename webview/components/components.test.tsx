import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavoriteCard, FavoriteItem } from '../../src/shared/cards'
import type { CandidatesPayload } from '../../src/shared/messages'
import { posted } from '../test/setup'
import { deckFor } from '../tipContent'
import { EntityCard, MissingCard } from './EntityCard'
import { groupByProject } from './FavoritesSection'
import { PickerModal } from './PickerModal'
import { SectionTipStrip } from './SectionTipStrip'

beforeEach(() => {
  posted.length = 0
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const card = (id: string, extra: Partial<FavoriteCard> = {}): FavoriteCard => ({
  entityType: 'session',
  entityId: id,
  title: `Title ${id}`,
  subtitle: 'proj · main',
  preview: `preview ${id}`,
  details: [{ label: 'PR', value: '#1', kind: 'link', href: 'https://x/1' }],
  status: null,
  statusVariant: null,
  updatedAt: '2026-09-14T10:00:00Z',
  group: { key: '/w/proj', label: 'proj' },
  meta: {},
  ...extra,
})

describe('SectionTipStrip', () => {
  const deck = deckFor('session', 'Sessions')

  it('picks its start index once and does not reshuffle on re-render', () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rerender } = render(<SectionTipStrip deck={deck} />)
    const first = screen.getByRole('note').textContent
    rand.mockReturnValue(0.1)
    rerender(<SectionTipStrip deck={deck} />)
    expect(screen.getByRole('note').textContent).toBe(first)
    expect(rand).toHaveBeenCalledTimes(1)
  })

  it('arrows step with wraparound and the pinned instruction never rotates', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    render(<SectionTipStrip deck={deck} />)
    const n = deck.tips.length
    expect(screen.getByText(`1/${n}`)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Previous tip'))
    expect(screen.getByText(`${n}/${n}`)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Next tip'))
    expect(screen.getByText(`1/${n}`)).toBeTruthy()
    for (let i = 0; i < n; i++) {
      expect(screen.getByText(deck.howToAdd, { exact: false })).toBeTruthy()
      fireEvent.click(screen.getByLabelText('Next tip'))
    }
  })

  it('a one-tip deck (unknown type fallback) renders without arrows', () => {
    render(<SectionTipStrip deck={deckFor('alien', 'Aliens')} />)
    expect(screen.queryByLabelText('Next tip')).toBeNull()
    expect(screen.getByRole('note').textContent).toContain('Aliens')
  })
})

describe('groupByProject', () => {
  const item = (id: string, order: number, c: FavoriteCard | null): FavoriteItem => ({
    id,
    entityType: 'session',
    entityId: id,
    label: `label ${id}`,
    note: null,
    sortOrder: order,
    createdAt: '',
    card: c,
    missing: c === null,
  })

  it('workspace first, then newest, missing last; sort_order within a group', () => {
    const buckets = groupByProject(
      [
        item(
          'a',
          3,
          card('a', {
            group: { key: '/w/other', label: 'other' },
            updatedAt: '2026-09-14T00:00:00Z',
          })
        ),
        item('b', 2, card('b')),
        item('c', 1, card('c')),
        item('gone', 0, null),
        item(
          'd',
          5,
          card('d', { group: { key: '/w/old', label: 'old' }, updatedAt: '2026-01-01T00:00:00Z' })
        ),
      ],
      ['/w/proj']
    )
    expect(buckets.map((b) => b.label)).toEqual(['proj', 'other', 'old', 'No longer on disk'])
    expect(buckets[0]!.inWorkspace).toBe(true)
    expect(buckets[0]!.items.map((i) => i.id)).toEqual(['c', 'b'])
  })
})

describe('EntityCard', () => {
  it('opens on title click, toggles the star, opens in a new window, and follows link details externally', () => {
    render(<EntityCard card={card('a')} variant="tile" verbose starred={false} />)
    fireEvent.click(screen.getByTitle('Title a'))
    fireEvent.click(screen.getByLabelText('Add to favorites'))
    fireEvent.click(screen.getByLabelText('Open in new window'))
    fireEvent.click(screen.getByText('#1'))
    expect(posted).toEqual([
      { type: 'open', entityType: 'session', entityId: 'a' },
      { type: 'toggleFavorite', entityType: 'session', entityId: 'a', label: 'Title a' },
      { type: 'open', entityType: 'session', entityId: 'a', target: 'window' },
      { type: 'openExternal', url: 'https://x/1' },
    ])
  })

  it('hides preview and details when not verbose; shows a live dot from status', () => {
    render(
      <EntityCard
        card={card('a', { status: 'live', statusVariant: 'success' })}
        variant="row"
        verbose={false}
        starred
      />
    )
    expect(screen.queryByText('preview a')).toBeNull()
    expect(screen.queryByText('#1')).toBeNull()
    expect(screen.getByLabelText('live')).toBeTruthy()
    expect(screen.getByLabelText('Remove from favorites').getAttribute('aria-pressed')).toBe('true')
  })

  it('a missing card shows the label snapshot and removes by favorite id', () => {
    render(<MissingCard label="Old label" id="fav_1" variant="tile" />)
    expect(screen.getByText('Old label')).toBeTruthy()
    fireEvent.click(screen.getByText('Remove'))
    expect(posted).toEqual([{ type: 'removeFavorite', id: 'fav_1' }])
  })
})

describe('PickerModal', () => {
  const payload = (items: FavoriteCard[], total = items.length): CandidatesPayload => ({
    entityType: 'session',
    query: '',
    items: items.map((c) => ({ ...c, favorited: false })),
    total,
    limit: 100,
  })

  it('requests candidates on open, ticks optimistically with no Save button, and reports truncation', async () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <PickerModal
        entityType="session"
        label="Sessions"
        candidates={null}
        favoritedIds={new Set()}
        onClose={onClose}
      />
    )
    await new Promise((r) => setTimeout(r, 10)) // the request is debounced
    expect(posted).toEqual([{ type: 'browse', entityType: 'session', query: '', limit: 100 }])
    rerender(
      <PickerModal
        entityType="session"
        label="Sessions"
        candidates={payload([card('a'), card('b')], 50)}
        favoritedIds={new Set()}
        onClose={onClose}
      />
    )
    expect(screen.getByText(/2 of 50 sessions/)).toBeTruthy()
    expect(screen.getByText(/showing the 2 most recent/)).toBeTruthy()
    expect(screen.queryByText(/save/i)).toBeNull()
    const box = screen.getByLabelText<HTMLInputElement>('Favorite Title a')
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(box.checked).toBe(true) // optimistic, before the host confirms
    expect(posted[1]).toEqual({
      type: 'toggleFavorite',
      entityType: 'session',
      entityId: 'a',
      label: 'Title a',
    })
    // Host confirms: the tick stays on with no flicker.
    rerender(
      <PickerModal
        entityType="session"
        label="Sessions"
        candidates={payload([card('a'), card('b')], 50)}
        favoritedIds={new Set(['a'])}
        onClose={onClose}
      />
    )
    expect(screen.getByLabelText<HTMLInputElement>('Favorite Title a').checked).toBe(true)
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(
      <PickerModal
        entityType="session"
        label="Sessions"
        candidates={null}
        favoritedIds={new Set()}
        onClose={onClose}
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
