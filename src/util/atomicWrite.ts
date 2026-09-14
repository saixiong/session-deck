import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write-then-rename so a reader (another VS Code window, the P6 skill) never
 * sees a half-written file. The temp name carries the pid so two writers in
 * different windows cannot collide on it.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, contents, 'utf8')
  await rename(tmp, path)
}
