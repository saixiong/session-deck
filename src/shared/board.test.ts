import { describe, expect, it } from 'vitest'
import {
  boardKey,
  compareBoardSessions,
  itemIdOf,
  itemsOf,
  normaliseItemText,
  orderItems,
  promptForItems,
  reconcileItems,
} from './board'
import type { ReviewItem } from './board'

describe('normaliseItemText / itemIdOf', () => {
  it('ignores list markers, case, inner whitespace and trailing punctuation', () => {
    expect(normaliseItemText('  1. Merge   PR #42.  ')).toBe('merge pr #42')
    expect(normaliseItemText('- Merge PR #42')).toBe('merge pr #42')
    expect(itemIdOf('Merge PR #42')).toBe(itemIdOf('2) merge pr #42!'))
  })

  it('separates items that really differ, and is stable across calls', () => {
    expect(itemIdOf('Merge PR #42')).not.toBe(itemIdOf('Merge PR #43'))
    expect(itemIdOf('Merge PR #42')).toMatch(/^[0-9a-f]{12}$/)
    expect(itemIdOf('x')).toBe(itemIdOf('x'))
    expect(boardKey('s1', itemIdOf('x'))).toBe(`s1:${itemIdOf('x')}`)
  })
})

describe('reconcileItems', () => {
  const steps = ['Merge PR #42', 'Update the changelog']
  const blockers = ['CI is red on main']

  it('keeps the strings canonical, in order, next steps before blockers', () => {
    const items = reconcileItems(steps, blockers, [
      { text: 'ci is red on main.', kind: 'decision' },
      { text: 'Merge PR #42', kind: 'mechanical', effort: 'small' },
    ])
    expect(items.map((i) => i.text)).toEqual([...steps, ...blockers])
    expect(items.map((i) => i.source)).toEqual(['next_step', 'next_step', 'blocker'])
    expect(items[0]).toMatchObject({ kind: 'mechanical', effort: 'small' })
    // Matching is normalised, so punctuation and case still find their string.
    expect(items[2]!.kind).toBe('decision')
  })

  it('degrades to unclassified rather than mis-tagging, and drops inventions', () => {
    const items = reconcileItems(steps, blockers, [
      { text: 'Merge PR #42', kind: 'nonsense' as never, effort: 'huge' as never },
      { text: 'Rewrite the whole store', kind: 'mechanical' },
    ])
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.kind)).toEqual(['unclassified', 'unclassified', 'unclassified'])
    expect(items[0]!.effort).toBeNull()
    expect(items.some((i) => i.text.includes('Rewrite'))).toBe(false)
  })

  it('collapses a list that repeats itself and ignores empty entries', () => {
    const items = reconcileItems(['Do it', 'do it.', '   '], ['Do it'], [])
    expect(items).toHaveLength(1)
  })

  it('calls a sentence that is in both lists a blocker, not a next step', () => {
    // One piece of work, so one row — two rows would share a content-derived
    // id and therefore one board key, and ticking either would tick both.
    // Of the two readings, blocked is the one worth surfacing.
    const items = reconcileItems(['Unblock CI', 'Merge PR #42'], ['Unblock CI'], [])
    expect(items.map((i) => [i.text, i.source])).toEqual([
      ['Unblock CI', 'blocker'],
      ['Merge PR #42', 'next_step'],
    ])
    expect(orderItems(items)[0]!.text).toBe('Unblock CI')
  })
})

describe('orderItems', () => {
  const at = (text: string, source: ReviewItem['source']): ReviewItem => ({
    id: itemIdOf(text),
    text,
    source,
    kind: 'mechanical',
    effort: null,
  })

  it('puts blockers first and keeps the report s own order inside each half', () => {
    const items = [
      at('a', 'next_step'),
      at('b', 'blocker'),
      at('c', 'next_step'),
      at('d', 'blocker'),
    ]
    expect(orderItems(items).map((i) => i.text)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('does not mutate what it was given', () => {
    const items = [at('a', 'next_step'), at('b', 'blocker')]
    orderItems(items)
    expect(items.map((i) => i.text)).toEqual(['a', 'b'])
  })
})

describe('compareBoardSessions', () => {
  const s = (priority: number | null, lastActiveAt: string) => ({ priority, lastActiveAt })

  it('ranks by priority, then by most recently active', () => {
    const sorted = [
      s(3, '2026-09-01T00:00:00Z'),
      s(5, '2026-01-01T00:00:00Z'),
      s(3, '2026-09-10T00:00:00Z'),
    ].sort(compareBoardSessions)
    expect(sorted.map((x) => [x.priority, x.lastActiveAt.slice(0, 10)])).toEqual([
      [5, '2026-01-01'],
      [3, '2026-09-10'],
      [3, '2026-09-01'],
    ])
  })

  it('sorts an unreviewed session last rather than treating it as priority 0', () => {
    expect(compareBoardSessions(s(null, 'z'), s(1, 'a'))).toBeGreaterThan(0)
  })

  it('is a total order: equal sessions compare 0 and the comparison is symmetric', () => {
    const a = s(3, '2026-09-01T00:00:00Z')
    const b = s(3, '2026-09-01T00:00:00Z')
    expect(compareBoardSessions(a, b)).toBe(0)
    const x = s(4, 'p')
    const y = s(2, 'q')
    expect(Math.sign(compareBoardSessions(x, y))).toBe(-Math.sign(compareBoardSessions(y, x)))
  })

  it('keeps a run of tied sessions in the order it was given', () => {
    // A comparator that never returns 0 leaves this to the sort's internals.
    const tied = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id,
      ...s(3, '2026-09-01T00:00:00Z'),
    }))
    expect([...tied].sort(compareBoardSessions).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('itemsOf', () => {
  it('uses stored items, and derives unclassified rows for pre-Board reports', () => {
    const legacy = { items: [], next_steps: ['Merge PR #42'], blockers: [] }
    expect(itemsOf(legacy).map((i) => i.kind)).toEqual(['unclassified'])
    const current = {
      items: reconcileItems(['Merge PR #42'], [], [{ text: 'Merge PR #42', kind: 'mechanical' }]),
      next_steps: ['Merge PR #42'],
      blockers: [],
    }
    expect(itemsOf(current)[0]!.kind).toBe('mechanical')
  })
})

describe('promptForItems', () => {
  it('numbers the items and tells the agent to stop at a forking decision', () => {
    const p = promptForItems(['Merge PR #42', ' Update the changelog '])
    expect(p).toContain('1. Merge PR #42')
    expect(p).toContain('2. Update the changelog')
    expect(p).toContain('stop and ask me')
  })
})
