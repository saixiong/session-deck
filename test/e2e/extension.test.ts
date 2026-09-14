import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as vscode from 'vscode'
import type { SessionDeckApi } from '../../src/extension'

/**
 * Smoke suite run inside a real VS Code by @vscode/test-cli. The extension is
 * pointed at test/fixtures/claude (a tiny ~/.claude look-alike) and a temp
 * data dir, so nothing on the machine is read or written.
 */
async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 8000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const EXT_ID = 'saixiong.session-deck'
const FIXTURE_PROJECTS = resolve(__dirname, '../../../test/fixtures/claude/projects')
const A = '11111111-1111-4111-8111-111111111111'

let api: SessionDeckApi
let dataDir: string

suite('Session Deck — smoke', () => {
  suiteSetup(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'session-deck-e2e-'))
    const config = vscode.workspace.getConfiguration('sessionDeck')
    await config.update('claudeProjectsDir', FIXTURE_PROJECTS, vscode.ConfigurationTarget.Workspace)
    await config.update('dataDir', dataDir, vscode.ConfigurationTarget.Workspace)
  })

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration('sessionDeck')
    await config.update('claudeProjectsDir', undefined, vscode.ConfigurationTarget.Workspace)
    await config.update('dataDir', undefined, vscode.ConfigurationTarget.Workspace)
    await rm(dataDir, { recursive: true, force: true })
  })

  test('extension activates and returns its test api', async () => {
    const ext = vscode.extensions.getExtension<SessionDeckApi>(EXT_ID)
    assert.ok(ext, `extension ${EXT_ID} not found`)
    api = await ext.activate()
    assert.equal(ext.isActive, true)
    assert.ok(api.services)
  })

  test('commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    for (const c of [
      'sessionDeck.openDashboard',
      'sessionDeck.favoriteCurrentSession',
      'sessionDeck.toggleFavorite',
      'sessionDeck.reindex',
    ]) {
      assert.ok(commands.includes(c), `${c} missing`)
    }
  })

  test('the index picks up the fixture sessions and hides the SDK one', async () => {
    await waitFor(() => (api.services.indexer.status().total === 4 ? true : undefined))
    await api.services.indexer.whenIdle()
    const visible = api.services.sessions.recent()
    assert.equal(visible.length, 3)
    assert.ok(visible.every((e) => e.entrypoint !== 'sdk-cli'))
    const a = api.services.indexer.get(A)
    assert.equal(a?.aiTitle, 'Fix login bug and ship')
    assert.equal(a?.prLinks[0]?.number, 42)
  })

  test('the tree shows Favorites / Live / Recent and groups Recent by project', async () => {
    const roots = await api.tree.getChildren()
    assert.deepEqual(
      roots.map((n) => (n.kind === 'section' ? n.id : n.kind)),
      ['favorites', 'live', 'recent']
    )
    const recent = roots[2]!
    const projects = await api.tree.getChildren(recent)
    assert.deepEqual(projects.map((n) => (n.kind === 'project' ? n.label : n.kind)).sort(), [
      'demo',
      'other',
    ])
    const demo = projects.find((n) => n.kind === 'project' && n.label === 'demo')!
    const rows = await api.tree.getChildren(demo)
    assert.equal(rows.length, 2)
    const item = api.tree.getTreeItem(rows[0]!)
    assert.equal(item.contextValue, 'session:unstarred')
    assert.equal(item.command?.command, 'sessionDeck.openSession')
  })

  test('starring persists to favorites.json, shows in the tree, and is idempotent', async () => {
    await vscode.commands.executeCommand('sessionDeck.favorite', A)
    await vscode.commands.executeCommand('sessionDeck.favorite', A)
    await api.services.favoritesReady
    assert.equal(api.services.favorites.list().length, 1)
    const onDisk = JSON.parse(await readFile(join(dataDir, 'favorites.json'), 'utf8')) as {
      favorites: Array<{ entity_id: string; label: string }>
    }
    assert.equal(onDisk.favorites[0]?.entity_id, A)
    assert.equal(onDisk.favorites[0]?.label, 'Fix login bug and ship')

    const roots = await api.tree.getChildren()
    const favProjects = await api.tree.getChildren(roots[0])
    assert.equal(favProjects.length, 1)
    const favRows = await api.tree.getChildren(favProjects[0])
    const starred = api.tree.getTreeItem(favRows[0]!)
    assert.equal(starred.contextValue, 'session:starred')
    assert.equal(starred.label, 'Fix login bug and ship')

    // The same session in Recent now carries the starred context too.
    const recentProjects = await api.tree.getChildren(roots[2])
    const demo = recentProjects.find((n) => n.kind === 'project' && n.label === 'demo')!
    const rows = await api.tree.getChildren(demo)
    const aRow = rows.find((r) => r.kind === 'session' && r.entry?.sessionId === A)!
    assert.equal(api.tree.getTreeItem(aRow).contextValue, 'session:starred')

    await vscode.commands.executeCommand('sessionDeck.toggleFavorite', A)
    assert.equal(api.services.favorites.list().length, 0)
  })

  test('favoriteCurrentSession reports when nothing is live here', async () => {
    // No pid files in the fixture sessions dir → the command must not throw.
    await vscode.commands.executeCommand('sessionDeck.favoriteCurrentSession')
    assert.equal(api.services.favorites.list().length, 0)
  })

  test('openDashboard opens a single Session Deck tab, and re-running reveals it', async () => {
    await vscode.commands.executeCommand('sessionDeck.openDashboard')
    await vscode.commands.executeCommand('sessionDeck.openDashboard')
    const deckTabs = await waitFor(() => {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      const found = tabs.filter((t) => t.label === 'Session Deck')
      return found.length > 0 ? found : undefined
    })
    assert.equal(deckTabs.length, 1, 'expected exactly one Session Deck tab')
  })
})
