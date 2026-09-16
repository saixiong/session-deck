import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as vscode from 'vscode'
import type { SessionDeckApi } from '../../src/extension'
import { itemIdOf, itemsOf } from '../../src/shared/board'
import {
  CLAUDE_PANEL_VIEW_TYPE,
  countClaudePanels,
  isPanelOpen,
} from '../../src/open/SessionOpener'

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
const FAKE_CLAUDE = resolve(__dirname, '../../../test/fixtures/fake-claude.sh')
const DAY_MS = 24 * 60 * 60 * 1000
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

let api: SessionDeckApi
let dataDir: string

suite('Session Deck — smoke', () => {
  suiteSetup(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'session-deck-e2e-'))
    // Written before the extension is activated, so activation is what prunes
    // it (B3.2). One expired seeded row for a session nobody stars, one fresh
    // seeded row, and one decision that must outlive both.
    const old = new Date(Date.now() - 60 * DAY_MS).toISOString()
    await writeFile(
      join(dataDir, 'board.json'),
      JSON.stringify({
        version: 1,
        items: {
          'gone:expired': {
            state: 'seeded',
            text: 'Seeded long ago for a session nobody stars',
            session_id: 'gone',
            updated_at: old,
            seeded_at: old,
          },
          'gone:fresh': {
            state: 'seeded',
            text: 'Seeded just now',
            session_id: 'gone',
            updated_at: new Date().toISOString(),
            seeded_at: new Date().toISOString(),
          },
          'gone:decided': {
            state: 'dismissed',
            text: 'A decision is kept however old it is',
            session_id: 'gone',
            updated_at: old,
            seeded_at: null,
          },
        },
      })
    )
    const config = vscode.workspace.getConfiguration('sessionDeck')
    await config.update('claudeProjectsDir', FIXTURE_PROJECTS, vscode.ConfigurationTarget.Workspace)
    await config.update('dataDir', dataDir, vscode.ConfigurationTarget.Workspace)
    await config.update('claudePath', FAKE_CLAUDE, vscode.ConfigurationTarget.Workspace)
    await config.update('model', 'haiku', vscode.ConfigurationTarget.Workspace)
  })

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration('sessionDeck')
    await config.update('claudeProjectsDir', undefined, vscode.ConfigurationTarget.Workspace)
    await config.update('dataDir', undefined, vscode.ConfigurationTarget.Workspace)
    await config.update('claudePath', undefined, vscode.ConfigurationTarget.Workspace)
    await config.update('model', undefined, vscode.ConfigurationTarget.Workspace)
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

  test('a review batch runs through the (fake) CLI, caches to disk, and reports a failure inline', async () => {
    await vscode.commands.executeCommand('sessionDeck.favorite', A)
    await vscode.commands.executeCommand('sessionDeck.favorite', B)
    const { runner, reviews } = api.services
    const events: string[] = []
    runner.onProgress((p) => events.push(JSON.stringify(p.status)))
    const progress = await runner.analyze([A, B])
    assert.equal(progress.done, 2)
    assert.equal(progress.failed, 0)
    assert.ok(progress.cost_usd > 0.006, `cost ${progress.cost_usd}`)
    assert.ok(
      events.some((e) => e.includes('"running"')),
      'saw a running state'
    )
    const a = reviews.get(A)
    assert.equal(a?.priority, 4)
    assert.equal(a?.options.length, 2)
    assert.equal(a?.model, 'haiku')
    const onDisk = JSON.parse(await readFile(join(dataDir, 'reviews', `${A}.json`), 'utf8')) as {
      fingerprint: string
    }
    assert.ok(onDisk.fingerprint.includes(':'))
    // Fresh reviews are skipped next time; forcing re-runs them.
    assert.equal((await runner.analyze([A, B])).ids.length, 0)
    assert.equal((await runner.analyze([A], { force: true })).done, 1)

    // A failing CLI reports inline and leaves the cache untouched.
    process.env['FAKE_CLAUDE_FAIL'] = '1'
    try {
      const failed = await runner.analyze([B], { force: true })
      assert.equal(failed.failed, 1)
      assert.match(failed.errors[B] ?? '', /Not logged in/)
      assert.ok(reviews.get(B), 'previous good review kept')
    } finally {
      delete process.env['FAKE_CLAUDE_FAIL']
    }
    await vscode.commands.executeCommand('sessionDeck.unfavorite', A)
    await vscode.commands.executeCommand('sessionDeck.unfavorite', B)
  })

  test('reviewSession from the tree opens the dashboard and tracks a non-favorite', async () => {
    await vscode.commands.executeCommand('sessionDeck.reviewSession', B)
    await waitFor(() => (api.services.runner.running ? undefined : true))
    assert.ok(api.services.reviews.get(B))
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

  test('activation prunes expired seeded board rows and keeps the decisions', async () => {
    const { board } = api.services
    await waitFor(() => (board.get('gone', 'expired') === undefined ? true : undefined))
    assert.equal(board.get('gone', 'expired'), undefined, 'the expired seeded row should be gone')
    assert.equal(board.get('gone', 'fresh')?.state, 'seeded', 'a fresh seeded row survives')
    assert.equal(
      board.get('gone', 'decided')?.state,
      'dismissed',
      'a dismissed row is a decision and is kept however old'
    )
    // And it is the file that changed, not just the in-memory copy.
    const raw = JSON.parse(await readFile(join(dataDir, 'board.json'), 'utf8')) as {
      items: Record<string, unknown>
    }
    assert.equal(Object.keys(raw.items).includes('gone:expired'), false)
  })

  test('board state is keyed by item text and survives a re-analysis', async () => {
    const { board, reviews } = api.services
    const review = reviews.get(A)
    assert.ok(review, 'session A should have a cached report by now')
    const item = itemsOf(review)[0]
    assert.ok(item, 'the report should carry at least one classified item')
    assert.equal(item.kind, 'mechanical')
    assert.equal(item.id, itemIdOf(item.text), 'the id is derived from the text, not stored')

    await board.setStates([{ sessionId: A, item, state: 'done' }])
    assert.equal(board.get(A, item.id)?.state, 'done')

    // Re-analyse: the fake CLI returns the same wording, so the tick holds.
    await api.services.runner.analyze([A], { force: true })
    const after = itemsOf(reviews.get(A)!)[0]
    assert.ok(after, 'the re-analysed report should still carry an item')
    assert.equal(after.id, item.id, 'same wording, same id')
    assert.equal(board.get(A, after.id)?.state, 'done', 'the tick survived the re-analysis')

    // A reworded item is new work, not an inherited state.
    assert.equal(board.get(A, itemIdOf(`${item.text} and deploy it`)), undefined)
    await board.setStates([{ sessionId: A, item, state: null }])
  })

  test('revealing the Session Deck sidebar opens the dashboard too', async () => {
    // Close every deck tab first, so what we observe is this reveal opening one.
    for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      if (tab.label === 'Session Deck') await vscode.window.tabGroups.close(tab)
    }
    await waitFor(() =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label === 'Session Deck')
        ? undefined
        : true
    )
    await vscode.commands.executeCommand('workbench.view.extension.sessionDeck')
    const tabs = await waitFor(() => {
      const found = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.label === 'Session Deck')
      return found.length > 0 ? found : undefined
    })
    assert.equal(tabs.length, 1, 'revealing the sidebar should open exactly one deck tab')
  })

  test('an open Claude Code panel is recognised by its tab (viewType + title)', async () => {
    // Claude Code creates its session panels with viewType "claudeVSCodePanel"
    // and labels the tab with the session title; a stand-in panel made the
    // same way proves the detector's viewType string and title matching.
    const before = countClaudePanels()
    assert.equal(isPanelOpen('Fix login bug and ship'), false)
    const panel = vscode.window.createWebviewPanel(
      'claudeVSCodePanel',
      'Fix login bug and ship',
      vscode.ViewColumn.Beside
    )
    try {
      await waitFor(() => (countClaudePanels() > before ? true : undefined))
      const tab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.label === 'Fix login bug and ship')
      assert.ok(tab?.input instanceof vscode.TabInputWebview)
      assert.equal(tab.input.viewType, CLAUDE_PANEL_VIEW_TYPE)
      assert.equal(isPanelOpen('Fix login bug and ship'), true)
      assert.equal(isPanelOpen('  Fix login bug   and ship '), true, 'whitespace-insensitive')
      assert.equal(isPanelOpen('Some other session'), false)
    } finally {
      panel.dispose()
    }
    await waitFor(() => (countClaudePanels() === before ? true : undefined))
    assert.equal(isPanelOpen('Fix login bug and ship'), false)
  })
})
