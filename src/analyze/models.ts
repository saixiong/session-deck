import { readFile } from 'node:fs/promises'
import type { SessionIndexEntry } from '../index/types'

/**
 * What the Review modal offers in its model picker.
 *
 * There is no "list models" API we can call: the CLI has no such command and
 * the Anthropic endpoint needs an API key, which this extension deliberately
 * does not have (D2 — it runs on the user's own login). Three sources stand
 * in for one, and between them they stay current on their own:
 *
 *  1. **Aliases** — `opus`, `sonnet`, `haiku`, `fable`, `opusplan`. An alias
 *     always resolves to the newest model of its family, so these need no
 *     refreshing to be right.
 *  2. **Claude Code's own cache** — `~/.claude.json`'s
 *     `additionalModelOptionsCache`, which Claude Code fills with the extra
 *     models this account can use, labelled and described. This is the "from
 *     Claude" part: new models appear here without us knowing their names.
 *  3. **Models seen in the user's own sessions** — concrete ids from the
 *     index, most recently used first. Evidence of real access, and it names
 *     a model the moment they first use it anywhere.
 *
 * `default` is not a model: it means "pass no --model and let Claude Code
 * choose", which follows the model it is set to today (verified: resolves the
 * same with and without the flag, even under our isolation flags).
 */
export interface ModelOption {
  /** Passed to `--model`; `default` means pass nothing. */
  value: string
  label: string
  description?: string
  source: 'default' | 'alias' | 'claude' | 'seen'
}

export const DEFAULT_MODEL = 'sonnet'
/** `--model` is omitted for this one; it is not an alias the CLI knows. */
export const FOLLOW_CLAUDE = 'default'

const ALIASES: ModelOption[] = [
  {
    value: FOLLOW_CLAUDE,
    label: 'Default',
    description: 'Whatever model Claude Code itself is set to — may cost more than Sonnet',
    source: 'default',
  },
  { value: 'opus', label: 'Opus', description: 'Latest Opus — deepest, priciest', source: 'alias' },
  {
    value: 'sonnet',
    label: 'Sonnet',
    description: 'Latest Sonnet — the balance reviews are tuned for',
    source: 'alias',
  },
  {
    value: 'haiku',
    label: 'Haiku',
    description: 'Latest Haiku — cheapest, good enough for most reports',
    source: 'alias',
  },
  { value: 'fable', label: 'Fable', description: 'Latest Fable', source: 'alias' },
]

/** Claude Code's cached list of the extra models this account may use. Absent or odd → none. */
export async function readClaudeModelOptions(configPath: string): Promise<ModelOption[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const cached = (parsed as { additionalModelOptionsCache?: unknown }).additionalModelOptionsCache
  if (!Array.isArray(cached)) return []
  const out: ModelOption[] = []
  for (const row of cached) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const value = typeof r['value'] === 'string' ? r['value'] : ''
    if (!value) continue
    const label = typeof r['label'] === 'string' && r['label'] ? r['label'] : value
    const description = typeof r['description'] === 'string' ? r['description'] : undefined
    out.push({ value, label, ...(description ? { description } : {}), source: 'claude' })
  }
  return out
}

/** Concrete model ids the indexed sessions actually used, most recently first. */
export function modelsSeen(entries: readonly SessionIndexEntry[]): ModelOption[] {
  const lastUsed = new Map<string, string>()
  for (const entry of entries) {
    for (const model of entry.models) {
      const at = lastUsed.get(model)
      if (!at || entry.lastActiveAt > at) lastUsed.set(model, entry.lastActiveAt)
    }
  }
  return [...lastUsed.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([value]) => ({ value, label: value, source: 'seen' as const }))
}

/**
 * The picker's list: aliases first (they never go stale), then anything Claude
 * Code knows about, then ids seen in real sessions. Deduplicated by value,
 * first source winning, and `current` is always present so a model chosen
 * before — or typed into settings by hand — never vanishes from its own picker.
 */
export function buildModelOptions(
  current: string,
  claude: readonly ModelOption[] = [],
  seen: readonly ModelOption[] = []
): ModelOption[] {
  const out: ModelOption[] = []
  const taken = new Set<string>()
  for (const option of [...ALIASES, ...claude, ...seen]) {
    if (taken.has(option.value)) continue
    taken.add(option.value)
    out.push(option)
  }
  if (current && !taken.has(current)) {
    out.push({ value: current, label: current, description: 'From your settings', source: 'seen' })
  }
  return out
}
