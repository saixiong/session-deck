import { describe, expect, it } from 'vitest'
import { clampCompletion, promptForItem } from './review'

describe('clampCompletion', () => {
  it('rounds and clamps numbers and numeric strings; anything else is unknown', () => {
    expect(clampCompletion(55.4)).toBe(55)
    expect(clampCompletion('72')).toBe(72)
    expect(clampCompletion(-3)).toBe(0)
    expect(clampCompletion(250)).toBe(100)
    expect(clampCompletion(undefined)).toBeNull()
    expect(clampCompletion('done')).toBeNull()
    expect(clampCompletion(NaN)).toBeNull()
  })
})

describe('promptForItem', () => {
  it('addresses the agent about exactly that item, trimmed', () => {
    const step = promptForItem('next_step', '  Merge PR #42 ')
    expect(step.startsWith('Pick up where we left off and do this next step: Merge PR #42')).toBe(
      true
    )
    const blocker = promptForItem('blocker', 'CI is red')
    expect(blocker.startsWith('Resolve this blocker before anything else: CI is red')).toBe(true)
    expect(blocker).toContain('ask')
  })
})
