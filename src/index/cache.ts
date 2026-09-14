import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../util/atomicWrite'
import type { IndexSnapshot, SessionIndexEntry } from './types'
import { INDEX_VERSION } from './types'

/**
 * The index cache is disposable: a missing, corrupt, or older-version file
 * costs a re-index and nothing else. It lives in globalStorage, never in the
 * user-visible data dir.
 */
export async function loadIndexCache(path: string): Promise<Map<string, SessionIndexEntry>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return new Map()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Map()
  }
  if (typeof parsed !== 'object' || parsed === null) return new Map()
  const snapshot = parsed as Partial<IndexSnapshot>
  if (
    snapshot.version !== INDEX_VERSION ||
    typeof snapshot.sessions !== 'object' ||
    snapshot.sessions === null
  ) {
    return new Map()
  }
  const map = new Map<string, SessionIndexEntry>()
  for (const [id, entry] of Object.entries(snapshot.sessions)) {
    if (isEntry(entry)) map.set(id, entry)
  }
  return map
}

export async function saveIndexCache(
  path: string,
  sessions: Map<string, SessionIndexEntry>
): Promise<void> {
  const snapshot: IndexSnapshot = { version: INDEX_VERSION, sessions: Object.fromEntries(sessions) }
  await writeFileAtomic(path, JSON.stringify(snapshot))
}

function isEntry(value: unknown): value is SessionIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['sessionId'] === 'string' &&
    typeof v['filePath'] === 'string' &&
    typeof v['size'] === 'number' &&
    typeof v['mtimeMs'] === 'number' &&
    typeof v['parsedTo'] === 'number' &&
    typeof v['tokens'] === 'object' &&
    Array.isArray(v['prLinks'])
  )
}
