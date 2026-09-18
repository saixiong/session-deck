import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavoriteGroup } from '../../src/shared/cards'
import type { BoardState, DashboardPrefs, SearchState } from '../../src/shared/messages'
import { DEFAULT_PREFS } from '../../src/shared/messages'
import { posted } from '../test/setup'
import { BoardView } from './BoardView'
import { FavoritesSection } from './FavoritesSection'
import { SearchBox } from './SearchBox'

beforeEach(() => {
  posted.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const search = (query = '', matched = 0, total = 892): SearchState => ({ query, matched, total })

describe('SearchBox', () => {
  it('debounces typing into one setSearch, and shows the count once the host answers', () => {
    const { rerender } = render(<SearchBox search={search()} />)
    const input = screen.getByRole('searchbox', { name: 'Search sessions' })
    fireEvent.input(input, { target: { value: 'log' } })
    fireEvent.input(input, { target: { value: 'login' } })
    expect(posted).toEqual([])
    vi.advanceTimersByTime(150)
    expect(posted).toEqual([{ type: 'setSearch', query: 'login' }])
    expect(screen.queryByText(/of 892/)).toBeNull()
    rerender(<SearchBox search={search('login', 12)} />)
    expect(screen.getByText('12 of 892')).toBeTruthy()
  })

  it('Escape and the × clear at once, without the debounce', () => {
    render(<SearchBox search={search('login', 12)} />)
    const input = screen.getByRole('searchbox', { name: 'Search sessions' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(posted).toEqual([{ type: 'setSearch', query: '' }])
    posted.length = 0
    fireEvent.input(input, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(posted).toEqual([{ type: 'setSearch', query: '' }])
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('does not echo a host query over text the user is still typing', () => {
    const { rerender } = render(<SearchBox search={search()} />)
    const input = screen.getByRole('searchbox', { name: 'Search sessions' })
    input.focus()
    fireEvent.input(input, { target: { value: 'login bu' } })
    rerender(<SearchBox search={search('login', 3)} />) // the host caught up to an earlier value
    expect((input as HTMLInputElement).value).toBe('login bu')
  })
})

const prefs: DashboardPrefs = { ...DEFAULT_PREFS }
const emptyGroup: FavoriteGroup = { entityType: 'session', label: 'Sessions', icon: 'x', items: [] }

describe('empty states while searching', () => {
  it('an empty favorites section says "no match", not the tip deck', () => {
    const { rerender } = render(
      <FavoritesSection
        group={emptyGroup}
        prefs={prefs}
        workspaceKeys={[]}
        onAdd={() => undefined}
        reviewEnabled={false}
      />
    )
    expect(document.querySelector('.tip')).toBeTruthy()
    rerender(
      <FavoritesSection
        group={emptyGroup}
        prefs={prefs}
        workspaceKeys={[]}
        onAdd={() => undefined}
        reviewEnabled={false}
        searching
      />
    )
    expect(document.querySelector('.tip')).toBeNull()
    expect(screen.getByText('No starred sessions match.')).toBeTruthy()
  })

  it('an empty board says the search emptied it, not that nothing was starred', () => {
    const board: BoardState = { rows: [], unreviewed: 0, starred: 3 }
    render(<BoardView board={board} prefs={prefs} onReview={() => undefined} searching />)
    expect(screen.getByText(/No board items belong to a matching session/)).toBeTruthy()
  })
})
