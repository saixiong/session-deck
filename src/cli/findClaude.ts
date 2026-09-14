import { access, constants, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * The vscode-free twin of util/claudeCli.ts for the skill: the Claude Code
 * extension's bundled binary (whichever version is installed), then PATH,
 * then the CLI's own install location.
 */
async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function findClaudeCli(): Promise<string | undefined> {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const extDir = join(homedir(), '.vscode', 'extensions')
  try {
    const names = (await readdir(extDir))
      .filter((n) => n.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
    for (const name of names) {
      const bundled = join(extDir, name, 'resources', 'native-binary', exe)
      if (await executable(bundled)) return bundled
    }
  } catch {
    // no VS Code extensions dir
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir && (await executable(join(dir, exe)))) return join(dir, exe)
  }
  const home = join(homedir(), '.local', 'bin', exe)
  return (await executable(home)) ? home : undefined
}
