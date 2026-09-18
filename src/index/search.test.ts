import { describe, expect, it } from 'vitest'
import { matchSession, matchesQuery, matchesTexts, normaliseQuery } from './search'

const base = {
  sessionId: 'abcdef12-0000-4000-8000-000000000000',
  customTitle: null as string | null,
  aiTitle: 'Fix the login bug' as string | null,
  firstPrompt: 'The login form 500s when the password has a quote',
  lastPrompt: 'ship it' as string | null,
  preview: 'Merged PR #42; the regression test covers quotes.' as string | null,
  cwd: '/Users/u/projects/snippbot',
  slug: '-Users-u-projects-snippbot',
  gitBranches: ['fix/login-quote'],
  prLinks: [{ number: 42, url: 'https://x/42', repo: 'u/snippbot' }],
}

describe('normaliseQuery', () => {
  it('lowercases, splits on whitespace, and treats blank as everything', () => {
    expect(normaliseQuery('  Login   BUG ')).toEqual(['login', 'bug'])
    expect(normaliseQuery('')).toEqual([])
    expect(normaliseQuery(null)).toEqual([])
    expect(normaliseQuery('   ')).toEqual([])
  })
})

describe('matchesQuery', () => {
  it('finds a session by every field the spec lists (S3)', () => {
    for (const q of [
      'login bug', // title
      'password quote', // first prompt
      'ship', // last prompt
      'regression', // preview
      'snippbot', // project
      'login-quote', // branch
      '#42', // PR
      'abcdef', // id prefix
    ]) {
      expect(matchesQuery(base, normaliseQuery(q)), q).toBe(true)
    }
  })

  it('ANDs words across fields, and a word matching nothing fails the whole query', () => {
    expect(matchesQuery(base, normaliseQuery('login #42'))).toBe(true)
    expect(matchesQuery(base, normaliseQuery('login zebra'))).toBe(false)
  })

  it('an empty query matches everything', () => {
    expect(matchesQuery(base, [])).toBe(true)
  })

  it('a custom title wins for the title field, and null fields are skipped', () => {
    expect(matchesQuery({ ...base, customTitle: 'Auth hardening' }, ['auth'])).toBe(true)
    expect(
      matchesQuery({ ...base, lastPrompt: null, preview: null, aiTitle: null }, ['ship'])
    ).toBe(false)
  })

  it('matches the id by prefix only, and only from four characters', () => {
    expect(matchesQuery(base, ['abcd'])).toBe(true)
    expect(matchesQuery(base, ['abc'])).toBe(false)
    expect(matchesQuery(base, ['cdef'])).toBe(false)
  })

  it('falls back to the slug for the project when cwd is empty', () => {
    expect(matchesQuery({ ...base, cwd: '' }, ['snippbot'])).toBe(true)
  })
})

describe('matchesTexts', () => {
  it('is the same rule over plain strings, for sessions with no index entry', () => {
    expect(matchesTexts(['Fix login', null, undefined], ['fix'])).toBe(true)
    expect(matchesTexts(['Fix login'], ['fix', 'login'])).toBe(true)
    expect(matchesTexts(['Fix login'], ['fix', 'zebra'])).toBe(false)
    expect(matchesTexts([], [])).toBe(true)
  })
})

describe('matchSession (S6)', () => {
  const content = {
    wordsIn: (id: string, words: readonly string[]) =>
      id === base.sessionId ? words.filter((w) => ['cookie', 'logout'].includes(w)) : [],
  }

  it('metadata alone is a hit with nothing via content', () => {
    expect(matchSession(base, ['login'], content)).toEqual({ hit: true, viaContent: [] })
  })

  it('a word only the transcript has is a hit that says so', () => {
    expect(matchSession(base, ['login', 'cookie'], content)).toEqual({
      hit: true,
      viaContent: ['cookie'],
    })
  })

  it('a word in neither is a miss, and the partial content hits are still reported', () => {
    expect(matchSession(base, ['cookie', 'zebra'], content)).toEqual({
      hit: false,
      viaContent: ['cookie'],
    })
  })

  it('without a content index, unmatched words are simply misses', () => {
    expect(matchSession(base, ['cookie'])).toEqual({ hit: false, viaContent: [] })
    expect(matchSession(base, [])).toEqual({ hit: true, viaContent: [] })
  })
})
