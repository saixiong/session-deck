import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** Expand a leading `~` and make the path absolute. Settings store `~/...` strings. */
export function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
    return resolve(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}
