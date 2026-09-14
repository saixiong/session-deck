import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Running Claude Code processes advertise themselves in
 * ~/.claude/sessions/<pid>.json (spec §3.3). Files outlive crashes, so a
 * session is only "live" when its pid still answers `kill(pid, 0)`.
 */
export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  name: string
  entrypoint: string
  kind: string
  startedAt: number
  updatedAt: number
}

export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (pid, signal) => process.kill(pid, signal)
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function parseLiveSession(raw: string): LiveSession | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const pid = typeof v['pid'] === 'number' ? v['pid'] : NaN
  const sessionId = typeof v['sessionId'] === 'string' ? v['sessionId'] : ''
  if (!Number.isInteger(pid) || !sessionId) return undefined
  const s = (k: string) => (typeof v[k] === 'string' ? v[k] : '')
  const n = (k: string) => (typeof v[k] === 'number' ? v[k] : 0)
  return {
    pid,
    sessionId,
    cwd: s('cwd'),
    name: s('name'),
    entrypoint: s('entrypoint'),
    kind: s('kind'),
    startedAt: n('startedAt'),
    updatedAt: n('updatedAt'),
  }
}

export async function readLiveSessions(
  sessionsDir: string,
  alive: (pid: number) => boolean = isProcessAlive
): Promise<LiveSession[]> {
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw: string
    try {
      raw = await readFile(join(sessionsDir, name), 'utf8')
    } catch {
      continue
    }
    const session = parseLiveSession(raw)
    if (session && alive(session.pid)) out.push(session)
  }
  // Newest activity first; stable for equal timestamps.
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
