import * as vscode from 'vscode'
import { resolveClaudeCli } from '../util/claudeCli'

/**
 * Opens a Claude Code session, optionally with a prompt SEEDED into the
 * composer — never sent (spec D9). Wraps the Claude Code extension's
 * unpublished hooks behind one seam (spec §7.4, R1):
 *
 *  1. `claude-vscode.editor.open(sessionId, initialPrompt)` — the panel in
 *     THIS window. Verified 2026-09-14: the extension resolves ids against
 *     the current workspace's sessions and, when it cannot find one, quietly
 *     creates a NEW session carrying the prompt. So path 1 is only used for
 *     sessions whose cwd is inside this window's workspace.
 *  2. a new window on the session's folder + the
 *     `vscode://anthropic.claude-code/open?session=&prompt=` URI — the
 *     cross-project path.
 *  3. a terminal in the session's cwd running `claude --resume <id>` with the
 *     prompt typed but not executed — opt-in, or the fallback when the
 *     extension is absent.
 *
 * A prompt is ALWAYS copied to the clipboard as well. Path 1 cannot seed a
 * panel that is already open: Claude Code's `createPanel` reveals the existing
 * panel and drops the prompt ("Session is already open. Your prompt was not
 * applied — enter it manually."), and it exposes no way to set an open
 * composer's text (verified against 2.1.274: the only text-insert path,
 * `insert_at_mention`, is reachable solely through commands that read the
 * active text editor's selection). What it does do is free the session id
 * the moment its panel is disposed, and accept a view column. So an open
 * panel is RECYCLED: close its tab, reopen the session in the same column
 * with the prompt — unless the session is mid-turn (`busy` in its live
 * record), in which case the panel is left alone and the clipboard is the
 * answer. A draft in that composer is lost by the recycle; the prompt was
 * about to replace it anyway.
 */
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code'
export const OPEN_COMMAND = 'claude-vscode.editor.open'
export const FOCUS_COMMAND = 'claude-vscode.toggleFocusView'
/** Focuses the composer of the visible Claude panel (Claude Code's "Focus input" command). */
export const FOCUS_INPUT_COMMAND = 'claude-vscode.focus'
export const OPEN_URI_BASE = 'vscode://anthropic.claude-code/open'
/** `TabInputWebview.viewType` of a Claude Code session panel. */
export const CLAUDE_PANEL_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel'

export type OpenTarget = 'panel' | 'window' | 'terminal'

export interface OpenRequest {
  sessionId: string
  prompt?: string
  /** The session's working directory from the index; decides the path. */
  cwd?: string
  /** The session's title from the index — Claude Code labels its tab with it, which is how an already-open panel is recognised. */
  title?: string
  /** Force a target regardless of the setting (e.g. the card's "Open in new window"). */
  target?: OpenTarget
}

/** How the prompt reached the user: seeded into a fresh composer, typed into a terminal, or clipboard only. */
export type PromptDelivery = 'seeded' | 'typed' | 'clipboard' | 'none'

export type OpenOutcome =
  { ok: true; via: OpenTarget; prompt: PromptDelivery } | { ok: false; reason: string }

/** What the opener needs from the rest of the extension. */
export interface OpenerDeps {
  /** Claude Code's live-record `status` for the session (`busy` / `idle`), or undefined when not live. Read fresh, never cached. */
  liveStatus?: (sessionId: string) => Promise<string | undefined>
}

export class SessionOpener {
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly deps: OpenerDeps = {}
  ) {}

  async open(req: OpenRequest): Promise<OpenOutcome> {
    if (!isSessionId(req.sessionId)) return this.fail(`"${req.sessionId}" is not a session id`)
    if (req.prompt) await this.copyPrompt(req.prompt)
    const config = vscode.workspace.getConfiguration('sessionDeck')
    const target = req.target ?? config.get<OpenTarget>('openTarget', 'panel')
    const inWorkspace = req.cwd ? isInsideWorkspace(req.cwd) : false

    if (target === 'terminal') return this.viaTerminal(req)
    if (target === 'window') return this.viaNewWindow(req)

    // target === 'panel'
    if (!req.cwd || inWorkspace) {
      const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)
      if (!ext) return this.noExtension(req)
      return this.viaPanel(req, ext)
    }
    // Cross-project: the panel would create a new session instead. Say so once.
    this.output.appendLine(
      `[open] ${req.sessionId} belongs to ${req.cwd}, outside this workspace → new window`
    )
    return this.viaNewWindow(req)
  }

  private async viaPanel(req: OpenRequest, ext: vscode.Extension<unknown>): Promise<OpenOutcome> {
    if (!ext.isActive) await ext.activate()
    const commands = await vscode.commands.getCommands(true)
    if (!commands.includes(OPEN_COMMAND)) {
      const version = String((ext.packageJSON as { version?: string }).version)
      this.output.appendLine(
        `[open] ${OPEN_COMMAND} missing in Claude Code ${version}; using the terminal path`
      )
      return this.viaTerminal(req)
    }
    // Passing a prompt to a panel that is already open makes Claude Code
    // reveal it, drop the prompt and complain. When the tab is recognisable
    // by title, recycle it: close and reopen in place with the prompt seeded.
    // If that is not safe (mid-turn) or not possible (two tabs share the
    // title), reveal it WITHOUT the prompt and fall back to the clipboard
    // hint — one message, ours, with the caret already in place.
    const openTab =
      req.prompt !== undefined && req.title !== undefined ? findPanelTab(req.title) : undefined
    if (openTab !== undefined && openTab !== 'ambiguous') {
      const recycled = await this.recyclePanel(req, openTab)
      if (recycled) return recycled
    }
    const alreadyOpen = openTab !== undefined
    const before = countClaudePanels()
    try {
      await vscode.commands.executeCommand(
        OPEN_COMMAND,
        req.sessionId,
        alreadyOpen ? undefined : req.prompt
      )
    } catch (err) {
      this.output.appendLine(`[open] ${OPEN_COMMAND} failed: ${String(err)}`)
      return this.fail(`could not open the session (${String(err)})`)
    }
    if (vscode.workspace.getConfiguration('sessionDeck').get<boolean>('openInFocusView', false)) {
      if (commands.includes(FOCUS_COMMAND)) void vscode.commands.executeCommand(FOCUS_COMMAND)
    }
    if (!req.prompt) return { ok: true, via: 'panel', prompt: 'none' }
    // A new panel takes the prompt; an existing one is only revealed. The
    // extension gives no answer either way, so watch for a tab to appear.
    const opened = alreadyOpen
      ? false
      : await waitFor(() => countClaudePanels() > before, NEW_TAB_WAIT_MS)
    if (opened) return { ok: true, via: 'panel', prompt: 'seeded' }
    this.output.appendLine(
      `[open] ${req.sessionId} was already open (${alreadyOpen ? 'matched by title' : 'no new tab'}); prompt left on the clipboard`
    )
    if (commands.includes(FOCUS_INPUT_COMMAND)) {
      // Put the caret in that panel's composer so ⌘V lands in the right place.
      await vscode.commands.executeCommand(FOCUS_INPUT_COMMAND)
    }
    void vscode.window.showInformationMessage(
      `Session Deck: the session was already open, so the prompt is on your clipboard — press ${pasteKey()} in the composer.`
    )
    return { ok: true, via: 'panel', prompt: 'clipboard' }
  }

  /**
   * Close the session's open tab and reopen it in the same column with the
   * prompt seeded. Returns undefined when it declined (mid-turn) so the
   * caller falls back; returns a failure only if the tab was closed and the
   * session could not be brought back, which it then tries to undo.
   */
  private async recyclePanel(req: OpenRequest, tab: vscode.Tab): Promise<OpenOutcome | undefined> {
    const status = await this.deps.liveStatus?.(req.sessionId)
    if (status === 'busy') {
      this.output.appendLine(`[open] ${req.sessionId} is mid-turn; not recycling its panel`)
      return undefined
    }
    const column = tab.group.viewColumn
    const title = req.title ?? ''
    const closed = await vscode.window.tabGroups.close(tab)
    if (!closed || !(await waitFor(() => !isPanelOpen(title), TAB_CLOSE_WAIT_MS))) {
      this.output.appendLine(`[open] could not close the tab for ${req.sessionId}; falling back`)
      return undefined
    }
    // Claude Code drops its own record of the tab on the same tab-change
    // event we just awaited; one more tick lets that listener run first.
    await delay(TAB_SETTLE_MS)
    const before = countClaudePanels()
    try {
      await vscode.commands.executeCommand(OPEN_COMMAND, req.sessionId, req.prompt, column)
    } catch (err) {
      this.output.appendLine(`[open] reopen after recycle failed: ${String(err)}`)
    }
    if (await waitFor(() => countClaudePanels() > before, NEW_TAB_WAIT_MS)) {
      this.output.appendLine(
        `[open] ${req.sessionId} recycled in column ${String(column)}; prompt seeded`
      )
      return { ok: true, via: 'panel', prompt: 'seeded' }
    }
    // The tab is gone and nothing came back: restore the session without the
    // prompt so the user is no worse off than before the click.
    this.output.appendLine(`[open] ${req.sessionId} did not reopen with the prompt; restoring`)
    try {
      await vscode.commands.executeCommand(OPEN_COMMAND, req.sessionId, undefined, column)
    } catch {
      // Nothing more to try; the failure below says what happened.
    }
    return this.fail('the session could not be reopened with the prompt (it is on your clipboard)')
  }

  /** Never fatal: a clipboard that refuses (remote, sandbox) still leaves the other paths intact. */
  private async copyPrompt(prompt: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(prompt)
      vscode.window.setStatusBarMessage('Session Deck: prompt copied to the clipboard', 8000)
    } catch (err) {
      this.output.appendLine(`[open] clipboard write failed: ${String(err)}`)
    }
  }

  private async viaNewWindow(req: OpenRequest): Promise<OpenOutcome> {
    const url = buildOpenUri(req.sessionId, req.prompt)
    if (req.cwd) {
      const folder = vscode.Uri.file(req.cwd)
      try {
        await vscode.workspace.fs.stat(folder)
      } catch {
        return this.fail(`the session's folder no longer exists: ${req.cwd}`)
      }
      // The new window needs a moment before it can take the URI; the Claude
      // extension queues it via onUri, but only once its window exists.
      await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: true })
      await delay(1500)
    }
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url))
    } catch (err) {
      return this.fail(`could not hand the session to the new window (${String(err)})`)
    }
    return { ok: true, via: 'window', prompt: req.prompt ? 'seeded' : 'none' }
  }

  private async viaTerminal(req: OpenRequest): Promise<OpenOutcome> {
    const cli = await resolveClaudeCli()
    if (!cli) return this.fail('no `claude` CLI found — set sessionDeck.claudePath')
    const terminal = vscode.window.createTerminal({
      name: `claude · ${req.sessionId.slice(0, 8)}`,
      ...(req.cwd ? { cwd: req.cwd } : {}),
    })
    terminal.show()
    terminal.sendText(`${shellQuote(cli.path)} --resume ${req.sessionId}`, true)
    if (req.prompt) {
      // Typed, not executed (spec D9). The interactive CLI needs a moment to
      // be ready to accept input; a heuristic, which is why this path is opt-in.
      await delay(2500)
      // A newline would be an Enter — auto-sending, or worse, a shell line if
      // the CLI is not up yet. Flatten it; the composer is single-line anyway.
      terminal.sendText(req.prompt.replace(/[\r\n]+/g, ' ').trim(), false)
    }
    return { ok: true, via: 'terminal', prompt: req.prompt ? 'typed' : 'none' }
  }

  private async noExtension(req: OpenRequest): Promise<OpenOutcome> {
    const useTerminal = 'Open in terminal'
    const install = 'Find the extension'
    const choice = await vscode.window.showWarningMessage(
      'Session Deck needs the Claude Code extension to open a session in the panel.',
      useTerminal,
      install
    )
    if (choice === useTerminal) return this.viaTerminal(req)
    if (choice === install)
      void vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION_ID)
    return this.fail('Claude Code extension not installed')
  }

  private fail(reason: string): OpenOutcome {
    this.output.appendLine(`[open] ${reason}`)
    void vscode.window.showErrorMessage(`Session Deck: ${reason}.`)
    return { ok: false, reason }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude Code validates ids before use; so do we, so a bad id never reaches a shell. */
export function isSessionId(value: string): boolean {
  return UUID.test(value)
}

export function buildOpenUri(sessionId: string, prompt?: string): string {
  const params = new URLSearchParams({ session: sessionId })
  if (prompt) params.set('prompt', prompt)
  return `${OPEN_URI_BASE}?${params.toString()}`
}

export function isInsideWorkspace(
  cwd: string,
  folders = vscode.workspace.workspaceFolders ?? []
): boolean {
  return folders.some((f) => {
    const root = f.uri.fsPath
    return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
  })
}

const NEW_TAB_WAIT_MS = 1500
const TAB_CLOSE_WAIT_MS = 1500
const TAB_SETTLE_MS = 50

/**
 * The Claude Code panel tab labelled `title`, if exactly one is open.
 * `'ambiguous'` when two are: a tab is only identifiable by its label, and
 * recycling the wrong session's panel would cost someone else's draft.
 */
export function findPanelTab(
  title: string,
  groups = vscode.window.tabGroups.all
): vscode.Tab | 'ambiguous' | undefined {
  const want = normalizeTitle(title)
  if (!want) return undefined
  let found: vscode.Tab | undefined
  for (const g of groups)
    for (const t of g.tabs)
      if (
        t.input instanceof vscode.TabInputWebview &&
        t.input.viewType === CLAUDE_PANEL_VIEW_TYPE &&
        normalizeTitle(t.label) === want
      ) {
        if (found) return 'ambiguous'
        found = t
      }
  return found
}

/** Is a Claude Code panel whose tab is labelled `title` open in this window? */
export function isPanelOpen(title: string, groups = vscode.window.tabGroups.all): boolean {
  return findPanelTab(title, groups) !== undefined
}

function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * How many Claude Code session panels this window has open. A count, not a
 * set of Tab objects: the tab model can be resynced wholesale, which would
 * make every existing tab look new by identity.
 */
export function countClaudePanels(groups = vscode.window.tabGroups.all): number {
  let n = 0
  for (const g of groups)
    for (const t of g.tabs)
      if (t.input instanceof vscode.TabInputWebview && t.input.viewType === CLAUDE_PANEL_VIEW_TYPE)
        n++
  return n
}

async function waitFor(check: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return true
    await delay(stepMs)
  }
  return check()
}

function pasteKey(): string {
  return process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
}

function shellQuote(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
