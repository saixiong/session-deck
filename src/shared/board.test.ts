import { describe, expect, it } from 'vitest'
import {
  boardKey,
  itemIdOf,
  itemsOf,
  normaliseItemText,
  promptForItems,
  reconcileItems,
} from './board'

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
