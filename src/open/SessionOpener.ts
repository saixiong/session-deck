import * as vscode from 'vscode'

/**
 * Opens a Claude Code session, optionally with a prompt SEEDED into the
 * composer — never sent (spec D9). Wraps the Claude Code extension's
 * unpublished hooks behind one seam (spec §7.4, R1):
 *
 *  1. `claude-vscode.editor.open(sessionId, initialPrompt)` — the panel
 *  2. `vscode://anthropic.claude-code/open?session=&prompt=` — a new window
 *  3. a terminal running `claude --resume <id>` with the prompt typed, not run
 *
 * P2 ships path 1 with a clear failure message; P3 adds 2, 3, focus view and
 * the cross-project handling.
 */
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code'
export const OPEN_COMMAND = 'claude-vscode.editor.open'

export interface OpenRequest {
  sessionId: string
  prompt?: string
  cwd?: string
}

export class SessionOpener {
  constructor(private readonly output: vscode.OutputChannel) {}

  claudeExtension(): vscode.Extension<unknown> | undefined {
    return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)
  }

  async open(req: OpenRequest): Promise<boolean> {
    if (!isSessionId(req.sessionId)) {
      void vscode.window.showErrorMessage(`Session Deck: "${req.sessionId}" is not a session id.`)
      return false
    }
    const ext = this.claudeExtension()
    if (!ext) {
      const install = 'Open Extensions'
      const choice = await vscode.window.showWarningMessage(
        'Session Deck needs the Claude Code extension to open a session.',
        install
      )
      if (choice === install) {
        void vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION_ID)
      }
      return false
    }
    if (!ext.isActive) await ext.activate()
    const commands = await vscode.commands.getCommands(true)
    if (!commands.includes(OPEN_COMMAND)) {
      this.output.appendLine(
        `[open] ${OPEN_COMMAND} not registered by Claude Code ${String((ext.packageJSON as { version?: string }).version)}`
      )
      void vscode.window.showWarningMessage(
        'Session Deck: this Claude Code version does not expose the open-session command.'
      )
      return false
    }
    try {
      await vscode.commands.executeCommand(OPEN_COMMAND, req.sessionId, req.prompt)
      return true
    } catch (err) {
      this.output.appendLine(`[open] ${OPEN_COMMAND} failed: ${String(err)}`)
      void vscode.window.showErrorMessage(
        `Session Deck: could not open the session (${String(err)}).`
      )
      return false
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude Code validates ids before use; so do we, so a bad id never reaches a shell. */
export function isSessionId(value: string): boolean {
  return UUID.test(value)
}
