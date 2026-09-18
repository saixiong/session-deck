import { spawn } from 'node:child_process'

/**
 * One headless `claude -p` call with structured output (spec §3.5, §9.3).
 * Recorded shape (2026-09-14, CLI 2.1.201): `{type:"result", subtype,
 * is_error, result:<json string>, structured_output:<object>, total_cost_usd,
 * duration_ms, usage, session_id, ...}`. Both `structured_output` and
 * `result` are handed to the parser; either may be missing on error.
 *
 * Isolation: `--setting-sources ""` (no hooks, no MCP from settings, no
 * CLAUDE.md), `--strict-mcp-config`, `--tools ""`, a replaced system prompt,
 * `--no-session-persistence` (a review must never appear as a session), a
 * neutral cwd, and CLAUDE_* env overrides stripped. `--bare` is NOT used: it
 * also disables the stored login (verified).
 */
export interface CliRequest {
  cliPath: string
  prompt: string
  systemPrompt: string
  schema: object
  model: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface CliResult {
  ok: boolean
  structured: unknown
  resultText: string | undefined
  costUsd: number | null
  durationMs: number | null
  errorText: string | undefined
  /** Raw stdout when it was not JSON, for the output channel. */
  raw?: string
}

export function cliArgs(req: Pick<CliRequest, 'systemPrompt' | 'schema' | 'model'>): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.schema),
    '--system-prompt',
    req.systemPrompt,
    '--model',
    req.model,
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--tools',
    '',
  ]
}

export function runClaude(req: CliRequest): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE_')) env[k] = v
    const child = spawn(req.cliPath, cliArgs(req), {
      cwd: req.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: CliResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const kill = () => {
      try {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
        }, 2000).unref()
      } catch {
        // already gone
      }
    }
    const onAbort = () => {
      kill()
      finish(fail('cancelled'))
    }
    const timer = setTimeout(() => {
      kill()
      finish(fail(`timed out after ${Math.round(req.timeoutMs / 1000)}s`))
    }, req.timeoutMs)
    timer.unref()
    if (req.signal?.aborted) return onAbort()
    req.signal?.addEventListener('abort', onAbort)

    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (err) => finish(fail(`could not start the claude CLI: ${err.message}`)))
    child.on('close', (code) => {
      const parsed = parseStdout(stdout)
      if (!parsed) {
        const detail = (stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400)
        finish({
          ...fail(`claude exited with code ${String(code)}${detail ? `: ${detail}` : ''}`),
          raw: stdout.slice(0, 2000),
        })
        return
      }
      const isError = parsed['is_error'] === true || parsed['subtype'] !== 'success'
      const resultText = typeof parsed['result'] === 'string' ? parsed['result'] : undefined
      finish({
        ok: !isError,
        structured: parsed['structured_output'],
        resultText,
        costUsd: typeof parsed['total_cost_usd'] === 'number' ? parsed['total_cost_usd'] : null,
        durationMs: typeof parsed['duration_ms'] === 'number' ? parsed['duration_ms'] : null,
        errorText: isError ? describeError(parsed, resultText) : undefined,
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(req.prompt)
  })
}

/**
 * The error subtypes (`error_max_structured_output_retries`, `error_max_turns`,
 * …) carry no `result` text; the reason lives in `errors[]`. Without it the
 * card can only say that the schema was not satisfied, never which field —
 * the difference between a bug report and a shrug.
 */
export function describeError(
  parsed: Record<string, unknown>,
  resultText: string | undefined
): string {
  const subtype = typeof parsed['subtype'] === 'string' ? parsed['subtype'] : 'error'
  const errors = Array.isArray(parsed['errors'])
    ? parsed['errors'].map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).filter(Boolean)
    : []
  const head = resultText?.trim() || subtype
  const text = errors.length ? `${head}: ${errors.join('; ')}` : head
  return text.slice(0, 600)
}

function fail(errorText: string): CliResult {
  return {
    ok: false,
    structured: undefined,
    resultText: undefined,
    costUsd: null,
    durationMs: null,
    errorText,
  }
}

/** stdout is one JSON object, but a stray warning line before it must not break parsing. */
export function parseStdout(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  const attempt = (s: string): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(s)
      return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  return attempt(text) ?? attempt(text.slice(text.indexOf('{')))
}
