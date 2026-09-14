import * as assert from 'node:assert/strict'
import * as vscode from 'vscode'

/**
 * Smoke suite run inside a real VS Code by @vscode/test-cli. It proves the
 * extension activates, the command exists, and the dashboard panel opens —
 * the P0 acceptance ("F5 opens an empty dashboard").
 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

suite('Session Deck — P0 smoke', () => {
  const id = 'saixiong.session-deck'

  test('extension is discoverable and activates', async () => {
    const ext = vscode.extensions.getExtension(id)
    assert.ok(ext, `extension ${id} not found`)
    await ext.activate()
    assert.equal(ext.isActive, true)
  })

  test('openDashboard command is registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(commands.includes('sessionDeck.openDashboard'))
  })

  test('openDashboard opens a single Session Deck tab, and re-running reveals it', async () => {
    await vscode.commands.executeCommand('sessionDeck.openDashboard')
    await vscode.commands.executeCommand('sessionDeck.openDashboard')
    // tabGroups is updated asynchronously after the panel is created.
    const deckTabs = await waitFor(() => {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      const found = tabs.filter((t) => t.label === 'Session Deck')
      return found.length > 0 ? found : undefined
    })
    assert.equal(deckTabs.length, 1, 'expected exactly one Session Deck tab')
  })
})
