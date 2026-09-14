import { describe, expect, it } from 'vitest'
import { isHostToWebview, isWebviewToHost } from './messages'

describe('postMessage guards', () => {
  it('accepts every WebviewToHost shape', () => {
    const ok: unknown[] = [
      { type: 'ready' },
      { type: 'openExternal', url: 'https://x' },
      { type: 'command', command: 'reload' },
      { type: 'command', command: 'reindex' },
      { type: 'setPeriod', period: '7d' },
      { type: 'setPrefs', prefs: { view: 'list' } },
      { type: 'toggleFavorite', entityType: 'session', entityId: 'a', label: 'A' },
      { type: 'removeFavorite', id: 'fav_1' },
      { type: 'moveFavorite', id: 'fav_1', beforeId: null },
      { type: 'moveFavorite', id: 'fav_1', beforeId: 'fav_2' },
      { type: 'open', entityType: 'session', entityId: 'a' },
      { type: 'open', entityType: 'session', entityId: 'a', prompt: 'go', target: 'window' },
      { type: 'browse', entityType: 'session', query: '', limit: 50 },
      { type: 'reviewAnalyze', ids: null, force: false },
      { type: 'reviewAnalyze', ids: ['a', 'b'], force: true },
      { type: 'reviewCancel' },
      { type: 'reviewDelete', sessionId: 'a' },
      { type: 'reviewDismissExtra', sessionId: 'a' },
    ]
    for (const m of ok) expect(isWebviewToHost(m), JSON.stringify(m)).toBe(true)
  })

  it('rejects malformed or unknown messages instead of throwing', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'ready',
      {},
      { type: 'nope' },
      { type: 'openExternal' },
      { type: 'command', command: 'rm -rf' },
      { type: 'setPeriod', period: '1y' },
      { type: 'setPrefs' },
      { type: 'toggleFavorite', entityType: 'alien', entityId: 'a', label: 'A' },
      { type: 'toggleFavorite', entityType: 'session', entityId: 'a' },
      { type: 'moveFavorite', id: 'fav_1' },
      { type: 'open', entityType: 'session', entityId: 'a', target: 'moon' },
      { type: 'browse', entityType: 'session', query: '' },
      { type: 'reviewAnalyze', ids: 'a', force: true },
      { type: 'reviewAnalyze', ids: null },
      { type: 'reviewDelete' },
    ]
    for (const m of bad) {
      expect(isWebviewToHost(m), JSON.stringify(m)).toBe(false)
      expect(isHostToWebview(m)).toBe(false)
    }
  })

  it('accepts host messages', () => {
    expect(isHostToWebview({ type: 'state', state: {} })).toBe(true)
    expect(isHostToWebview({ type: 'candidates', payload: {} })).toBe(true)
    expect(isHostToWebview({ type: 'toast', level: 'info', text: 'hi' })).toBe(true)
    expect(isHostToWebview({ type: 'showReview', focus: null })).toBe(true)
  })
})
