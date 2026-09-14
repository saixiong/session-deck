import { describe, expect, it } from 'vitest'
import type { LiveSession } from '../index/liveSessions'
import { applyRecord } from '../index/records'
import { ordinarySession, ts } from '../index/testFixtures'
import { newEntry } from '../index/tiers'
import type { SessionIndexEntry } from '../index/types'
import { formatTimeDistance } from '../shared/cards'
import type { Favorite } from '../store/FavoritesStore'
import { buildFavoriteGroups } from './favoritesView'
import { projectLabel, SessionResolver, shortModel } from './sessionResolver'
import { ResolverRegistry } from './types'

function entry(
  id: string,
  opts: { cwd?: string; entrypoint?: string; lastActiveAt?: string; missing?: boolean } = {}
): SessionIndexEntry {
  const e = newEntry(`/home/u/.claude/projects/-home-u-proj/${id}.jsonl`, 10, 10)
  for (const r of ordinarySession({
    sessionId: id,
    cwd: opts.cwd ?? '/home/u/proj',
    entrypoint: opts.entrypoint ?? 'claude-vscode',
  })) {
    applyRecord(e, r as Record<string, unknown>)
  }
  if (opts.lastActiveAt) e.lastActiveAt = opts.lastActiveAt
  if (opts.missing) e.missing = true
  e.fast = false
  return e
}

function resolver(
  entries: SessionIndexEntry[],
  live: LiveSession[] = [],
  showSdk = false,
  folders: string[] = ['/home/u/proj']
) {
  const map = new Map(entries.map((e) => [e.sessionId, e]))
  return new SessionResolver({
    entries: () => map.values(),
    get: (id) => map.get(id),
    live: () => live,
    isVisible: (e) => showSdk || e.entrypoint !== 'sdk-cli',
    workspaceFolders: () => folders,
  })
}

describe('SessionResolver', () => {
  it('hydrates cards with title, subtitle, preview, details and live status', () => {
    const r = resolver(
      [entry('a')],
      [
        {
          pid: 1,
          sessionId: 'a',
          cwd: '/home/u/proj',
          name: 'proj-1',
          entrypoint: 'claude-vscode',
          kind: 'interactive',
          startedAt: 0,
          updatedAt: 0,
        },
      ]
    )
    const cards = r.hydrate(['a', 'nope'])
    expect(cards.size).toBe(1)
    const card = cards.get('a')!
    expect(card.title).toBe('Fix login bug and ship')
    expect(card.subtitle).toBe('proj · main')
    expect(card.preview).toBe('Shipped as PR #42.')
    expect(card.status).toBe('live')
    expect(card.statusVariant).toBe('success')
    expect(card.group).toEqual({ key: '/home/u/proj', label: 'proj' })
    expect(card.meta['inWorkspace']).toBe(true)
    expect(card.meta['livePid']).toBe(1)
    const labels = card.details.map((d) => d.label)
    expect(labels).toEqual([
      'Turns',
      'Tool calls',
      'Output tokens',
      'PR',
      'Model',
      'Compactions',
      'Started',
    ])
    expect(card.details.find((d) => d.label === 'PR')).toMatchObject({
      value: '#42',
      kind: 'link',
      href: 'https://github.com/acme/demo/pull/42',
    })
    expect(card.details.find((d) => d.label === 'Model')?.value).toBe('opus-5')
  })

  it('hydrate ignores visibility (a starred SDK session still resolves) but not missing', () => {
    const r = resolver([entry('sdk', { entrypoint: 'sdk-cli' }), entry('gone', { missing: true })])
    expect(r.hydrate(['sdk']).size).toBe(1)
    expect(r.hydrate(['gone']).size).toBe(0)
  })

  it('browse filters by title/prompt/project/branch/PR, hides SDK sessions, sorts newest first, reports total', () => {
    const r = resolver([
      entry('old', { lastActiveAt: ts(0, '2026-01-01') }),
      entry('new', { lastActiveAt: ts(0, '2026-09-01') }),
      entry('sdk', { entrypoint: 'sdk-cli' }),
    ])
    const all = r.browse(null, 10)
    expect(all.total).toBe(2)
    expect(all.items.map((c) => c.entityId)).toEqual(['new', 'old'])
    expect(r.browse('login', 1).total).toBe(2)
    expect(r.browse('login', 1).items).toHaveLength(1)
    expect(r.browse('#42', 10).total).toBe(2)
    expect(r.browse('proj', 10).total).toBe(2)
    expect(r.browse('zzz', 10).total).toBe(0)
    expect(r.browse('main', 10).total).toBe(2)
  })

  it('suggest excludes favorited ids and aborted sessions', () => {
    const empty = newEntry('/x/-x/empty.jsonl', 1, 1)
    empty.fast = false
    const r = resolver([entry('a'), entry('b'), empty])
    expect(r.suggest(10, new Set(['a'])).map((c) => c.entityId)).toEqual(['b'])
  })

  it('projectLabel and shortModel', () => {
    expect(projectLabel({ cwd: '/Users/x/projects/snippbot', slug: 'whatever' })).toBe('snippbot')
    expect(projectLabel({ cwd: '', slug: '-Users-x-projects-demo' })).toBe('demo')
    expect(shortModel('claude-opus-5')).toBe('opus-5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
  })
})

describe('buildFavoriteGroups', () => {
  const row = (
    id: string,
    entityId: string,
    order: number,
    type: Favorite['entity_type'] = 'session'
  ): Favorite => ({
    id,
    entity_type: type,
    entity_id: entityId,
    label: `label ${entityId}`,
    note: null,
    sort_order: order,
    created_at: '',
    updated_at: '',
  })

  it('joins rows with cards, marks gone entities missing, keeps sort order, one group per resolver', () => {
    const registry = new ResolverRegistry()
    registry.register(resolver([entry('a'), entry('b')]))
    const groups = buildFavoriteGroups(
      [row('f2', 'b', 2), row('f1', 'a', 1), row('f3', 'gone', 3), row('f4', 'p', 4, 'project')],
      registry
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe('Sessions')
    expect(groups[0]!.items.map((i) => [i.entityId, i.missing])).toEqual([
      ['a', false],
      ['b', false],
      ['gone', true],
    ])
    expect(groups[0]!.items[2]!.label).toBe('label gone')
  })

  it('an empty registry section still renders (always-render, Snippbot D9)', () => {
    const registry = new ResolverRegistry()
    registry.register(resolver([]))
    expect(buildFavoriteGroups([], registry)[0]!.items).toEqual([])
  })
})

describe('formatTimeDistance', () => {
  const now = Date.parse('2026-09-14T12:00:00Z')
  it('reads in both directions', () => {
    expect(formatTimeDistance('2026-09-14T11:59:40Z', now)).toBe('just now')
    expect(formatTimeDistance('2026-09-14T11:15:00Z', now)).toBe('45m ago')
    expect(formatTimeDistance('2026-09-14T07:00:00Z', now)).toBe('5h ago')
    expect(formatTimeDistance('2026-09-10T12:00:00Z', now)).toBe('4d ago')
    expect(formatTimeDistance('2026-06-14T12:00:00Z', now)).toBe('3mo ago')
    expect(formatTimeDistance('2026-09-15T10:00:00Z', now)).toBe('in 22h')
    expect(formatTimeDistance(null, now)).toBe('')
    expect(formatTimeDistance('garbage', now)).toBe('')
  })
})
