import type { ComponentChildren } from 'preact'
import { useRef, useState } from 'preact/hooks'

export interface Pane {
  id: string
  /** Collapsed panes take their header's height and cannot be resized. */
  open: boolean
  /** A pane that renders nothing (an empty Suggested shelf) leaves no splitter behind. */
  hidden?: boolean
  node: ComponentChildren
}

interface Props {
  panes: Pane[]
  /** Relative weights of open panes, from prefs; a missing pane weighs 1. */
  sizes: Record<string, number>
  onSizes: (sizes: Record<string, number>) => void
}

/** A pane can be dragged no smaller than this — its header plus a row or two. */
const MIN_PANE_PX = 96
const KEY_STEP_PX = 24

/**
 * The dashboard's vertical stack (Snippbot Dashboard, layout). Open panes
 * share the height left under the header and stat strip in proportion to
 * their weights; collapsed ones take only their header, so with Live and
 * Suggested folded the Sessions section is the whole page. A splitter sits
 * between two adjacent open panes: drag it, or focus it and use the arrow
 * keys. Weights are persisted through prefs like collapse state, so every
 * window agrees; the drag itself is local until the pointer is released.
 */
export function Stack({ panes, sizes, onSizes }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<Record<string, number> | null>(null)
  /** The weights the drag has reached; committed on release without re-measuring. */
  const pending = useRef<Record<string, number> | null>(null)
  const weights = dragging ?? sizes
  const visible = panes.filter((p) => !p.hidden)
  const weightOf = (id: string) => Math.max(0.05, weights[id] ?? 1)

  /** Move the boundary between two open panes by `delta` pixels (down is positive). */
  const resize = (above: Pane, below: Pane, delta: number, commit: boolean) => {
    const el = root.current
    if (!el) return
    const a = el.querySelector<HTMLElement>(`[data-pane="${above.id.replace(/"/g, '')}"]`)
    const b = el.querySelector<HTMLElement>(`[data-pane="${below.id.replace(/"/g, '')}"]`)
    if (!a || !b) return
    const ha = a.getBoundingClientRect().height
    const hb = b.getBoundingClientRect().height
    const total = ha + hb
    if (total <= 2 * MIN_PANE_PX) return
    const next = Math.min(Math.max(ha + delta, MIN_PANE_PX), total - MIN_PANE_PX)
    // The pair keeps its combined weight; only the split moves.
    const pairWeight = weightOf(above.id) + weightOf(below.id)
    const updated = {
      ...weights,
      [above.id]: (next / total) * pairWeight,
      [below.id]: ((total - next) / total) * pairWeight,
    }
    if (commit) {
      pending.current = null
      setDragging(null)
      onSizes(updated)
    } else {
      pending.current = updated
      setDragging(updated)
    }
  }

  const startDrag = (e: PointerEvent, above: Pane, below: Pane) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture?.(e.pointerId)
    let last = e.clientY
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientY - last
      last = ev.clientY
      if (delta !== 0) resize(above, below, delta, false)
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      // Commit what the drag reached; a click that never moved changes nothing.
      const reached = pending.current
      pending.current = null
      setDragging(null)
      if (reached) onSizes(reached)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const out: ComponentChildren[] = []
  visible.forEach((pane, i) => {
    const previous = visible[i - 1]
    if (previous && previous.open && pane.open) {
      out.push(
        <div
          key={`split-${previous.id}-${pane.id}`}
          class="splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${previous.id} and ${pane.id}`}
          tabIndex={0}
          onPointerDown={(e) => startDrag(e, previous, pane)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            resize(previous, pane, e.key === 'ArrowDown' ? KEY_STEP_PX : -KEY_STEP_PX, true)
          }}
        >
          <span class="splitter__grip" aria-hidden="true" />
        </div>
      )
    }
    out.push(
      <div
        key={pane.id}
        class={`pane${pane.open ? ' pane--open' : ' pane--collapsed'}`}
        data-pane={pane.id}
        style={pane.open ? { flex: `${weightOf(pane.id)} 1 0px` } : undefined}
      >
        {pane.node}
      </div>
    )
  })
  return (
    <div class={`stack${dragging ? ' stack--dragging' : ''}`} ref={root}>
      {out}
    </div>
  )
}
