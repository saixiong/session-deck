import { useMemo, useState } from 'preact/hooks'
import type { BoardItemKind, BoardItemState } from '../../src/shared/board'
import { BOARD_KINDS, KIND_ICONS, KIND_LABELS } from '../../src/shared/board'
import type { BoardRow, BoardState, DashboardPrefs } from '../../src/shared/messages'
import { deckFor } from '../tipContent'
import { post } from '../vscodeApi'
import { SectionTipStrip } from './SectionTipStrip'

interface Props {
  board: BoardState
  prefs: DashboardPrefs
  /** Opens the Review modal, focused on a session. */
  onReview: (focus: string | null) => void
}

/**
 * The Deck Board (SPEC_BOARD B5): every outstanding to-do and blocker across
 * every starred session, in one list, tagged by what kind of work it is.
 *
 * The host sends every row with its state; the filtering lives here because
 * "show closed" and the kind filter are view preferences, not facts. Selection
 * is webview-local — it is a list of clicks, not something to persist (B7).
 */
export function BoardView({ board, prefs, onReview }: Props) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const kinds = prefs.boardKinds
  const showClosed = prefs.boardShowClosed

  const visible = useMemo(
    () =>
      board.rows.filter(
        (r) =>
          (showClosed || r.state === null || r.state === 'seeded') &&
          (kinds.length === 0 || kinds.includes(r.item.kind))
      ),
    [board.rows, kinds, showClosed]
  )
  const groups = useMemo(() => groupBySession(visible), [visible])
  const counts = useMemo(() => countByKind(board.rows), [board.rows])
  const open = board.rows.filter((r) => r.state === null || r.state === 'seeded').length

  const keyOf = (r: BoardRow) => `${r.sessionId}:${r.item.id}`
  const chosen = visible.filter((r) => selected.has(keyOf(r)))

  const toggle = (row: BoardRow) => {
    const key = keyOf(row)
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }

  const setState = (rows: BoardRow[], state: BoardItemState | null) => {
    if (rows.length === 0) return
    post({
      type: 'boardSetState',
      items: rows.map((r) => ({ sessionId: r.sessionId, itemId: r.item.id, text: r.item.text })),
      state,
    })
    setSelected(new Set())
  }

  const setPrefs = (patch: Partial<DashboardPrefs>) => post({ type: 'setPrefs', prefs: patch })
  const toggleKind = (kind: BoardItemKind) =>
    setPrefs({
      boardKinds: kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind],
    })

  return (
    <section class="board" aria-label="Board">
      <div class="board__head">
        <div class="board__status">
          <strong>{open}</strong> open
          {BOARD_KINDS.filter((k) => counts[k]).map((k) => (
            <span key={k}>
              {' · '}
              <strong>{counts[k]}</strong> {KIND_LABELS[k].toLowerCase()}
            </span>
          ))}
          {board.unreviewed ? (
            <>
              {' · '}
              <button class="linkish" type="button" onClick={() => onReview(null)}>
                {board.unreviewed} session{board.unreviewed === 1 ? '' : 's'} not reviewed yet
              </button>
            </>
          ) : null}
        </div>
        <div class="board__filters" role="group" aria-label="Filters">
          {BOARD_KINDS.map((k) => (
            <button
              key={k}
              class={`chip${kinds.includes(k) ? ' chip--on' : ''} chip--${k}`}
              type="button"
              aria-pressed={kinds.includes(k)}
              onClick={() => toggleKind(k)}
            >
              <span class={`codicon codicon-${KIND_ICONS[k]}`} aria-hidden="true" />{' '}
              {KIND_LABELS[k]}
            </button>
          ))}
          <button
            class={`chip${showClosed ? ' chip--on' : ''}`}
            type="button"
            aria-pressed={showClosed}
            onClick={() => setPrefs({ boardShowClosed: !showClosed })}
          >
            Show done
          </button>
        </div>
      </div>

      {chosen.length ? (
        <SelectionBar
          rows={chosen}
          onClear={() => setSelected(new Set())}
          onState={(state) => setState(chosen, state)}
        />
      ) : null}

      {groups.length === 0 ? (
        <BoardEmpty board={board} onReview={onReview} />
      ) : (
        groups.map(({ sessionId, rows }) => {
          const head = rows[0]!
          return (
            <div class="board__group" key={sessionId}>
              <div class="board__group-head">
                <button class="board__session" type="button" onClick={() => onReview(sessionId)}>
                  {head.sessionTitle}
                </button>
                <span class="board__group-meta muted">
                  {head.project ? `${head.project} · ` : ''}
                  {head.priority} {head.priorityLabel}
                  {head.completion !== null ? ` · ${head.completion}%` : ''}
                </span>
                {head.stale ? (
                  <span class="tag tag--warn" title="This session moved on since its last review">
                    out of date
                  </span>
                ) : null}
                <button
                  class="board__group-select"
                  type="button"
                  onClick={() => {
                    const next = new Set(selected)
                    const all = rows.every((r) => next.has(keyOf(r)))
                    for (const r of rows) {
                      if (all) next.delete(keyOf(r))
                      else next.add(keyOf(r))
                    }
                    setSelected(next)
                  }}
                >
                  {rows.every((r) => selected.has(keyOf(r))) ? 'None' : 'All'}
                </button>
              </div>
              <ul class="board__items">
                {rows.map((row) => (
                  <BoardItemRow
                    key={keyOf(row)}
                    row={row}
                    selected={selected.has(keyOf(row))}
                    onToggle={() => toggle(row)}
                    onState={(state) => setState([row], state)}
                  />
                ))}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}

/**
 * The three ways a board is empty, which are not the same problem (B5.2):
 * nothing starred yet gets the favorites tip deck, starred-but-unreviewed gets
 * the analyse action itself rather than a description of it, and a board
 * emptied by its own filters says so.
 */
function BoardEmpty({
  board,
  onReview,
}: {
  board: BoardState
  onReview: (focus: string | null) => void
}) {
  if (board.rows.length) return <p class="muted board__empty">Nothing matches these filters.</p>
  if (board.starred === 0) {
    return (
      <div class="board__empty">
        <p class="muted">Star a session and review it to fill the board.</p>
        <SectionTipStrip deck={deckFor('session', 'Sessions')} />
      </div>
    )
  }
  if (board.unreviewed) {
    return (
      <div class="board__empty">
        <p class="muted">
          Nothing to work through yet — the board lists what a review found outstanding.
        </p>
        <button
          class="button button--primary"
          type="button"
          onClick={() => {
            // The modal's own action, not a second analysis path (B5.2): open
            // it so the batch's per-session progress is visible while it runs.
            onReview(null)
            post({ type: 'reviewAnalyze', ids: null, force: false })
          }}
        >
          <span class="codicon codicon-sparkle" aria-hidden="true" /> Analyse {board.unreviewed}{' '}
          session{board.unreviewed === 1 ? '' : 's'}
        </button>
      </div>
    )
  }
  return (
    <p class="muted board__empty">
      Nothing outstanding — every item your reviews found is done or dismissed.
    </p>
  )
}

function BoardItemRow({
  row,
  selected,
  onToggle,
  onState,
}: {
  row: BoardRow
  selected: boolean
  onToggle: () => void
  onState: (state: BoardItemState | null) => void
}) {
  const closed = row.state === 'done' || row.state === 'dismissed'
  return (
    <li class={`bitem bitem--${row.item.kind}${closed ? ' bitem--closed' : ''}`}>
      <input
        type="checkbox"
        class="bitem__check"
        checked={selected}
        aria-label={`Select: ${row.item.text}`}
        onChange={onToggle}
      />
      <span
        class={`codicon codicon-${KIND_ICONS[row.item.kind]} bitem__kind`}
        title={KIND_LABELS[row.item.kind]}
        aria-label={KIND_LABELS[row.item.kind]}
        role="img"
      />
      <span class="bitem__text">
        {row.item.source === 'blocker' ? (
          <span class="tag tag--warn bitem__blocker">blocked</span>
        ) : null}
        {row.item.text}
      </span>
      {row.item.effort ? <span class="bitem__effort muted">{row.item.effort}</span> : null}
      {row.state ? <span class="bitem__state muted">{row.state}</span> : null}
      <span class="bitem__actions">
        <button
          class="bitem__act"
          type="button"
          title="Open the session with a prompt for this item — not sent"
          aria-label={`Do this: ${row.item.text}`}
          onClick={() =>
            post({
              type: 'boardSeed',
              sessionId: row.sessionId,
              items: [{ itemId: row.item.id, text: row.item.text }],
            })
          }
        >
          <span class="codicon codicon-arrow-right" aria-hidden="true" /> Do this
        </button>
        <button
          class="bitem__act"
          type="button"
          aria-label={closed ? `Reopen: ${row.item.text}` : `Mark done: ${row.item.text}`}
          onClick={() => onState(closed ? null : 'done')}
        >
          <span class={`codicon codicon-${closed ? 'history' : 'check'}`} aria-hidden="true" />{' '}
          {closed ? 'Reopen' : 'Done'}
        </button>
      </span>
    </li>
  )
}

/**
 * The bulk bar. Seeding is grouped per session and dispatched one click at a
 * time (B7): a selection spanning five sessions must never open five windows.
 */
function SelectionBar({
  rows,
  onClear,
  onState,
}: {
  rows: BoardRow[]
  onClear: () => void
  onState: (state: BoardItemState | null) => void
}) {
  const bySession = groupBySession(rows)
  return (
    <div class="board__bulk" role="group" aria-label="Selected items">
      <span class="board__bulk-count">
        <strong>{rows.length}</strong> selected
        {bySession.length > 1 ? ` in ${bySession.length} sessions` : ''}
      </span>
      <button class="button" type="button" onClick={() => onState('done')}>
        <span class="codicon codicon-check" aria-hidden="true" /> Done
      </button>
      <button class="button" type="button" onClick={() => onState('dismissed')}>
        Dismiss
      </button>
      <button class="button" type="button" onClick={onClear}>
        Clear
      </button>
      <div class="board__queue">
        {bySession.map(({ sessionId, rows: group }) => (
          <div class="board__queue-item" key={sessionId}>
            <span class="board__queue-title" title={group[0]!.sessionTitle}>
              {group[0]!.sessionTitle}
            </span>
            <span class="muted">
              {group.length} item{group.length === 1 ? '' : 's'}
            </span>
            <button
              class="button button--primary"
              type="button"
              onClick={() =>
                post({
                  type: 'boardSeed',
                  sessionId,
                  items: group.map((r) => ({ itemId: r.item.id, text: r.item.text })),
                })
              }
            >
              <span class="codicon codicon-arrow-right" aria-hidden="true" /> Seed
            </button>
            <button
              class="control control--icon"
              type="button"
              title="Copy the prompt without opening the session"
              aria-label={`Copy prompt for ${group[0]!.sessionTitle}`}
              onClick={() =>
                post({
                  type: 'boardSeed',
                  sessionId,
                  items: group.map((r) => ({ itemId: r.item.id, text: r.item.text })),
                  copyOnly: true,
                })
              }
            >
              <span class="codicon codicon-copy" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Keeps the host's ordering: sessions appear in the order their first row does. */
export function groupBySession(rows: BoardRow[]): Array<{ sessionId: string; rows: BoardRow[] }> {
  const out: Array<{ sessionId: string; rows: BoardRow[] }> = []
  const index = new Map<string, number>()
  for (const row of rows) {
    const at = index.get(row.sessionId)
    if (at === undefined) {
      index.set(row.sessionId, out.length)
      out.push({ sessionId: row.sessionId, rows: [row] })
    } else {
      out[at]!.rows.push(row)
    }
  }
  return out
}

function countByKind(rows: BoardRow[]): Record<BoardItemKind, number> {
  const counts: Record<BoardItemKind, number> = {
    mechanical: 0,
    decision: 0,
    user_action: 0,
    unclassified: 0,
  }
  for (const r of rows) if (r.state === null || r.state === 'seeded') counts[r.item.kind]++
  return counts
}
