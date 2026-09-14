import { describe, expect, it } from 'vitest'
import { isHostToWebview, isWebviewToHost } from './messages'

describe('postMessage guards', () => {
  it('accepts every WebviewToHost shape', () => {
    expect(isWebviewToHost({ type: 'ready' })).toBe(true)
    expect(isWebviewToHost({ type: 'openExternal', url: 'https://x' })).toBe(true)
    expect(isWebviewToHost({ type: 'command', command: 'reload' })).toBe(true)
  })

  it('rejects malformed or unknown messages instead of throwing', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'ready',
      {},
      { type: 'nope' },
      { type: 'openExternal' },
      { type: 'command', command: 'rm -rf' },
    ]) {
      expect(isWebviewToHost(bad)).toBe(false)
      expect(isHostToWebview(bad)).toBe(false)
    }
  })

  it('accepts a state message', () => {
    expect(
      isHostToWebview({ type: 'state', state: { extensionVersion: '0', phase: 'P0', stats: [] } })
    ).toBe(true)
  })
})
