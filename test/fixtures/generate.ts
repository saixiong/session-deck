/**
 * Regenerates test/fixtures/claude — a tiny ~/.claude look-alike the e2e
 * suite points the extension at. Run with: pnpm fixtures
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { bigSession, ordinarySession, writeSession } from '../../src/index/testFixtures'

async function main() {
  const root = join(process.cwd(), 'test', 'fixtures', 'claude')
  await rm(root, { recursive: true, force: true })
  const projects = join(root, 'projects')
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeSession(
    projects,
    '-Users-test-demo',
    '11111111-1111-4111-8111-111111111111',
    ordinarySession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/Users/test/demo' })
  )
  await writeSession(
    projects,
    '-Users-test-demo',
    '22222222-2222-4222-8222-222222222222',
    bigSession(
      { sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/Users/test/demo' },
      30,
      512
    )
  )
  await writeSession(
    projects,
    '-Users-test-other',
    '33333333-3333-4333-8333-333333333333',
    ordinarySession({
      sessionId: '33333333-3333-4333-8333-333333333333',
      cwd: '/Users/test/other',
      gitBranch: 'feat/x',
    })
  )
  await writeSession(
    projects,
    '-Users-test-other',
    '44444444-4444-4444-8444-444444444444',
    ordinarySession({
      sessionId: '44444444-4444-4444-8444-444444444444',
      cwd: '/Users/test/other',
      entrypoint: 'sdk-cli',
    })
  )
  console.log('fixtures written to', root)
}
void main()
