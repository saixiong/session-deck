import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliArgs } from './ClaudeCli'
import {
  buildModelOptions,
  FOLLOW_CLAUDE,
  modelsSeen,
  readClaudeModelOptions,
  type ModelOption,
} from './models'
import { newEntry } from '../index/tiers'
import type { SessionIndexEntry } from '../index/types'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deck-models-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const entry = (id: string, models: string[], lastActiveAt: string): SessionIndexEntry => {
  const e = newEntry(join(root, `${id}.jsonl`), 1, 1)
  e.sessionId = id
  e.models = models
  e.lastActiveAt = lastActiveAt
  return e
}

describe('readClaudeModelOptions', () => {
  it("reads Claude Code's own cached options, label and description included", async () => {
    // The recorded shape from ~/.claude.json, 2026-09-26.
    const path = join(root, '.claude.json')
    await writeFile(
      path,
      JSON.stringify({
        additionalModelOptionsCache: [
          {
            value: 'claude-fable-5-1[1m]',
            label: 'Fable',
            description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
          },
          { value: 'claude-opus-9' },
          { label: 'no value' },
          'junk',
        ],
      })
    )
    const options = await readClaudeModelOptions(path)
    expect(options).toEqual([
      {
        value: 'claude-fable-5-1[1m]',
        label: 'Fable',
        description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
        source: 'claude',
      },
      { value: 'claude-opus-9', label: 'claude-opus-9', source: 'claude' },
    ])
  })

  it('a missing, unreadable or shapeless file yields no options, never an error', async () => {
    expect(await readClaudeModelOptions(join(root, 'nope.json'))).toEqual([])
    const bad = join(root, 'bad.json')
    await writeFile(bad, 'not json')
    expect(await readClaudeModelOptions(bad)).toEqual([])
    const empty = join(root, 'empty.json')
    await writeFile(empty, '{"additionalModelOptionsCache":"nope"}')
    expect(await readClaudeModelOptions(empty)).toEqual([])
  })
})

describe('modelsSeen', () => {
  it('lists each model once, most recently used first', () => {
    const seen = modelsSeen([
      entry('a', ['claude-haiku-4-5', 'claude-opus-5'], '2026-09-01T00:00:00Z'),
      entry('b', ['claude-opus-5'], '2026-09-20T00:00:00Z'),
      entry('c', [], '2026-09-30T00:00:00Z'),
    ])
    expect(seen.map((m) => m.value)).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
    expect(seen.every((m) => m.source === 'seen')).toBe(true)
  })
})

describe('buildModelOptions', () => {
  const claude: ModelOption[] = [
    { value: 'claude-fable-5-1[1m]', label: 'Fable 1M', source: 'claude' },
    { value: 'sonnet', label: 'duplicate of an alias', source: 'claude' },
  ]
  const seen: ModelOption[] = [{ value: 'claude-opus-5', label: 'claude-opus-5', source: 'seen' }]

  it('puts the aliases first, then Claude Code, then what was seen — each value once', () => {
    const options = buildModelOptions('sonnet', claude, seen)
    expect(options.slice(0, 5).map((m) => m.value)).toEqual([
      FOLLOW_CLAUDE,
      'opus',
      'sonnet',
      'haiku',
      'fable',
    ])
    expect(options.filter((m) => m.value === 'sonnet')).toHaveLength(1)
    expect(options.find((m) => m.value === 'sonnet')?.source).toBe('alias')
    expect(options.map((m) => m.value)).toContain('claude-opus-5')
  })

  it('keeps a model set by hand in settings, so the picker cannot drop its own value', () => {
    const options = buildModelOptions('claude-something-unreleased', [], [])
    expect(options.at(-1)).toMatchObject({
      value: 'claude-something-unreleased',
      description: 'From your settings',
    })
  })
})

describe('cliArgs and the default model', () => {
  const base = { systemPrompt: 'sys', schema: { a: 1 } }

  it('passes --model for a real choice', () => {
    const args = cliArgs({ ...base, model: 'haiku' })
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
  })

  it('omits --model entirely for `default`, which is how Claude Code keeps its own choice', () => {
    expect(cliArgs({ ...base, model: FOLLOW_CLAUDE })).not.toContain('--model')
    expect(cliArgs({ ...base, model: '' })).not.toContain('--model')
  })
})
