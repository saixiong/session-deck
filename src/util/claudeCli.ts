import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import * as vscode from 'vscode'
import { expandHome } from './paths'

/**
 * Where the `claude` CLI lives (spec §9.3 step 3). The Claude Code extension
 * ships its own binary — and that is the one whose login the user definitely
 * has — so it is the first candidate; then an explicit setting, then PATH,
 * then the CLI's own install location.
 */
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code'

export interface ClaudeCliLocation {
  path: string
  source: 'setting' | 'extension' | 'path' | 'home'
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveClaudeCli(): Promise<ClaudeCliLocation | undefined> {
  const configured = vscode.workspace
    .getConfiguration('sessionDeck')
    .get<string>('claudePath', '')
    .trim()
  if (configured) {
    const path = expandHome(configured)
    return (await executable(path)) ? { path, source: 'setting' } : undefined
  }
  const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)
  if (ext) {
    const bundled = join(
      ext.extensionPath,
      'resources',
      'native-binary',
      process.platform === 'win32' ? 'claude.exe' : 'claude'
    )
    if (await executable(bundled)) return { path: bundled, source: 'extension' }
  }
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    if (await executable(candidate)) return { path: candidate, source: 'path' }
  }
  const home = join(homedir(), '.local', 'bin', exe)
  if (await executable(home)) return { path: home, source: 'home' }
  return undefined
}
