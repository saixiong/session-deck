import type { ReviewItem } from '../shared/board'
import { reconcileItems } from '../shared/board'
import type { ChatReview, ReviewOption } from '../shared/review'
import { clampCompletion, clampPriority, priorityLabel } from '../shared/review'

/**
 * What the model is asked for, and how its answer is recovered.
 *
 * The system prompt is Snippbot's Chat Review prompt verbatim plus two rules
 * about the header block this tool prepends (spec §9.4). The JSON schema is
 * handed to `claude -p --json-schema`; `parseReview` still tolerates a bare
 * `result` string with fences or preamble (Chat Review D6), because a model
 * that mostly complies is not one that always does.
 */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'done',
    'next_steps',
    'blockers',
    'priority',
    'priority_reason',
    'completion',
    'completion_reason',
    'items',
    'options',
  ],
  properties: {
    summary: { type: 'string' },
    done: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    priority_reason: { type: 'string' },
    completion: { type: 'integer', minimum: 0, maximum: 100 },
    completion_reason: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind'],
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['mechanical', 'decision', 'user_action'] },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
      },
    },
    options: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'description', 'prompt'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          prompt: { type: 'string' },
        },
      },
    },
  },
} as const

export const SYSTEM_PROMPT = `\
You are reviewing an ongoing work conversation between a user and an AI agent, \
and reporting where it stands. The user is triaging several such conversations \
at once and needs to decide which to return to first.

Reply with a single JSON object and nothing else. No prose, no code fence.

{
  "summary": "2-3 sentences on what this conversation is for and where it now stands.",
  "done": ["Concrete things already completed or decided. Specific, not generic."],
  "next_steps": ["Concrete things still outstanding, most important first."],
  "blockers": ["Anything stopping progress: an unanswered question, a failing test, a missing decision. Empty list if none."],
  "priority": 1-5,
  "priority_reason": "One sentence on why it sits at that level.",
  "completion": 0-100,
  "completion_reason": "One sentence on what the score is measured against and what is missing.",
  "items": [
    {
      "text": "Copied EXACTLY from next_steps or blockers above, not reworded.",
      "kind": "mechanical | decision | user_action",
      "effort": "small | medium | large"
    }
  ],
  "options": [
    {
      "id": "short-kebab-id",
      "label": "Short imperative, 2-5 words",
      "description": "One sentence on what taking this direction would do and why.",
      "prompt": "The message to send to the agent to start this. Address the agent directly, in the imperative."
    }
  ]
}

Priority means how much this work needs attention now:
  5 Critical  blocking other work, broken in production, or the user is waiting.
  4 High      active work with a clear, valuable next step.
  3 Medium    real work, no urgency.
  2 Low       nice to have, or nearly finished.
  1 Idle      finished, abandoned, or trivial.

Completion is a percentage of the goal the user set in this conversation, \
judged against the transcript, not against the length of the lists:
  0    nothing done toward it yet.
  50   the core work is half there, or done but unverified.
  90   done and verified; only cleanup, docs or a decision remain.
  100  done, verified, and nothing is left to do — say so in the summary.
Abandoned or trivial work still gets an honest number, not 100.

"items" must contain one entry for EVERY string you put in next_steps AND \
one for EVERY string you put in blockers — next_steps first, then blockers, \
same order. If next_steps has 3 entries and blockers has 2, items has exactly \
5. Never omit the blockers. Classify each as:
  mechanical   one obvious way to do it; no judgment that forks the code \
(merge the open PR, update the changelog, delete dead code).
  decision     needs a human choice that changes what gets built \
(which of two layouts, whether to fix an unrelated bug).
  user_action  only the user can do it: pushing their own commits, approving \
a submission, deciding when they are ready.
Copy each "text" exactly as written above — do not reword, merge or split \
entries. When unsure between mechanical and decision, answer decision.

Rules:
- Judge only from the transcript. Never invent progress that is not shown.
- 2 to 4 options. Make them genuinely different choices, not rephrasings.
- If the work looks finished, say so in the summary and offer options like \
verifying, documenting, or closing out rather than inventing new work.
- The SESSION header at the top of the transcript is authoritative for facts \
such as pull requests, branch and project; do not contradict it.
- A "[tool: ...]" line means the agent ran that tool. It says nothing about \
success unless a following "[result: ...]" line does.`

export interface ParsedReview {
  summary: string
  done: string[]
  next_steps: string[]
  blockers: string[]
  priority: number
  priority_reason: string
  completion: number | null
  completion_reason: string
  items: ReviewItem[]
  options: ReviewOption[]
}

/**
 * Recover the report from whatever the CLI returned: the structured object
 * when present, else the result text with code fences stripped and the
 * outermost {...} span taken. Throws with a readable reason when nothing
 * usable is there.
 */
export function parseReview(structured: unknown, resultText: string | undefined): ParsedReview {
  const obj = isObject(structured) ? structured : recoverObject(resultText ?? '')
  if (!obj) throw new Error('the model returned no JSON object')
  const options = toOptions(obj['options'])
  if (options.length === 0) throw new Error('the model returned no usable directions')
  const next_steps = strList(obj['next_steps'])
  const blockers = strList(obj['blockers'])
  return {
    summary: str(obj['summary']),
    done: strList(obj['done']),
    next_steps,
    blockers,
    priority: clampPriority(obj['priority']),
    priority_reason: str(obj['priority_reason']),
    completion: clampCompletion(obj['completion']),
    completion_reason: str(obj['completion_reason']),
    items: reconcileItems(next_steps, blockers, annotations(obj['items'])),
    options,
  }
}

/** The model's `items[]` as loose annotations; reconcileItems decides what survives (B3). */
function annotations(v: unknown): Partial<ReviewItem>[] {
  if (!Array.isArray(v)) return []
  const out: Partial<ReviewItem>[] = []
  for (const item of v) {
    if (!isObject(item)) continue
    const text = str(item['text'])
    if (!text) continue
    out.push({
      text,
      ...(typeof item['kind'] === 'string' ? { kind: item['kind'] as ReviewItem['kind'] } : {}),
      ...(typeof item['effort'] === 'string'
        ? { effort: item['effort'] as ReviewItem['effort'] }
        : {}),
    })
  }
  return out
}

export function makeReview(
  base: {
    conversation_id: string
    title: string
    model: string
    fingerprint: string
    message_count: number
    cost_usd: number | null
    duration_ms: number | null
  },
  parsed: ParsedReview,
  now = new Date()
): ChatReview {
  return {
    ...base,
    ...parsed,
    priority_label: priorityLabel(parsed.priority),
    analyzed_at: now.toISOString(),
    error: null,
  }
}

/** No messages is a valid assessment, not an error, and costs no model call (Chat Review D10). */
export function emptyReview(base: Parameters<typeof makeReview>[0], now = new Date()): ChatReview {
  return makeReview(
    { ...base, cost_usd: 0, duration_ms: 0 },
    {
      summary: 'This session has no conversation yet.',
      done: [],
      next_steps: [],
      blockers: [],
      priority: 1,
      priority_reason: 'Nothing has happened in it.',
      completion: 0,
      completion_reason: 'No work has been asked for or done.',
      items: [],
      options: [
        {
          id: 'start',
          label: 'Start the work',
          description: 'Open the session and describe what it should do.',
          prompt: 'Let us start. Here is what I need: ',
        },
      ],
    },
    now
  )
}

function recoverObject(text: string): Record<string, unknown> | undefined {
  let t = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t)
  if (fence?.[1]) t = fence[1]
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first === -1 || last <= first) return undefined
  try {
    const parsed: unknown = JSON.parse(t.slice(first, last + 1))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? x.trim() : String(x))).filter(Boolean)
    : []
}

/** An option with no prompt or label has nothing to submit, so it is dropped rather than shown broken. */
function toOptions(v: unknown): ReviewOption[] {
  if (!Array.isArray(v)) return []
  const out: ReviewOption[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (!isObject(item)) continue
    const label = str(item['label'])
    const prompt = str(item['prompt'])
    if (!label || !prompt) continue
    let id = str(item['id']) || label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    while (seen.has(id)) id = `${id}-2`
    seen.add(id)
    out.push({ id, label, description: str(item['description']), prompt })
  }
  return out.slice(0, 4)
}
