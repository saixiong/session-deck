import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Stack, type Pane } from './Stack'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const pane = (id: string, open = true, hidden = false): Pane => ({
  id,
  open,
  hidden,
  node: <section data-testid={`node-${id}`}>{id}</section>,
})

/** Give every pane a measured height so a drag has something to divide. */
function measure(heights: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const id = this.getAttribute('data-pane') ?? ''
    const height = heights[id] ?? 0
    return {
      height,
      width: 800,
      top: 0,
      left: 0,
      bottom: height,
      right: 800,
      x: 0,
      y: 0,
    } as DOMRect
  })
}

describe('Stack', () => {
  it('puts a splitter only between two adjacent open panes, and skips hidden ones', () => {
    render(
      <Stack
        panes={[
          pane('sessions'),
          pane('live', false),
          pane('suggested', true, true),
          pane('extra'),
        ]}
        sizes={{}}
        onSizes={() => undefined}
      />
    )
    // sessions|live: live is collapsed → none. live|extra: live collapsed → none.
    // suggested is hidden, so it neither renders nor leaves a splitter.
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
    expect(screen.queryByTestId('node-suggested')).toBeNull()
    cleanup()
    render(
      <Stack
        panes={[pane('sessions'), pane('live'), pane('suggested')]}
        sizes={{}}
        onSizes={() => undefined}
      />
    )
    expect(screen.getAllByRole('separator').map((s) => s.getAttribute('aria-label'))).toEqual([
      'Resize sessions and live',
      'Resize live and suggested',
    ])
  })

  it('open panes flex by their weight; a collapsed pane takes only its own height', () => {
    render(
      <Stack
        panes={[pane('sessions'), pane('live', false)]}
        sizes={{ sessions: 3 }}
        onSizes={() => undefined}
      />
    )
    const sessions = document.querySelector<HTMLElement>('[data-pane="sessions"]')!
    const live = document.querySelector<HTMLElement>('[data-pane="live"]')!
    expect(sessions.style.flex).toBe('3 1 0px')
    expect(live.className).toContain('pane--collapsed')
    expect(live.style.flex).toBe('')
  })

  it('a drag moves the split and commits once on release, keeping the pair weight', () => {
    measure({ sessions: 600, live: 200 })
    const onSizes = vi.fn()
    render(<Stack panes={[pane('sessions'), pane('live')]} sizes={{}} onSizes={onSizes} />)
    const splitter = screen.getByRole('separator')
    fireEvent.pointerDown(splitter, { button: 0, clientY: 600, pointerId: 1 })
    fireEvent.pointerMove(splitter, { clientY: 500, pointerId: 1 })
    // While dragging nothing is persisted; the stack shows it locally.
    expect(onSizes).not.toHaveBeenCalled()
    expect(document.querySelector('.stack')!.className).toContain('stack--dragging')
    fireEvent.pointerUp(splitter, { clientY: 500, pointerId: 1 })
    expect(onSizes).toHaveBeenCalledTimes(1)
    const sizes = onSizes.mock.calls[0]![0] as Record<string, number>
    // 800px shared, 100px moved up: sessions 500/800, live 300/800 of a pair weight of 2.
    expect(sizes['sessions']).toBeCloseTo(1.25)
    expect(sizes['live']).toBeCloseTo(0.75)
    expect(document.querySelector('.stack')!.className).not.toContain('stack--dragging')
  })

  it('a click without movement persists nothing', () => {
    measure({ sessions: 600, live: 200 })
    const onSizes = vi.fn()
    render(<Stack panes={[pane('sessions'), pane('live')]} sizes={{}} onSizes={onSizes} />)
    const splitter = screen.getByRole('separator')
    fireEvent.pointerDown(splitter, { button: 0, clientY: 600, pointerId: 1 })
    fireEvent.pointerUp(splitter, { clientY: 600, pointerId: 1 })
    expect(onSizes).not.toHaveBeenCalled()
  })

  it('will not shrink a pane below its minimum', () => {
    measure({ sessions: 600, live: 200 })
    const onSizes = vi.fn()
    render(<Stack panes={[pane('sessions'), pane('live')]} sizes={{}} onSizes={onSizes} />)
    const splitter = screen.getByRole('separator')
    fireEvent.pointerDown(splitter, { button: 0, clientY: 600, pointerId: 1 })
    fireEvent.pointerMove(splitter, { clientY: 5000, pointerId: 1 }) // far past the bottom
    fireEvent.pointerUp(splitter, { clientY: 5000, pointerId: 1 })
    const sizes = onSizes.mock.calls[0]![0] as Record<string, number>
    // live keeps 96px of 800: 96/800 × 2 = 0.24
    expect(sizes['live']).toBeCloseTo(0.24)
  })

  it('arrow keys on a focused splitter resize in steps and commit', () => {
    measure({ sessions: 400, live: 400 })
    const onSizes = vi.fn()
    render(<Stack panes={[pane('sessions'), pane('live')]} sizes={{}} onSizes={onSizes} />)
    const splitter = screen.getByRole('separator')
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    expect(onSizes).toHaveBeenCalledTimes(1)
    const sizes = onSizes.mock.calls[0]![0] as Record<string, number>
    expect(sizes['sessions']).toBeCloseTo((424 / 800) * 2)
    fireEvent.keyDown(splitter, { key: 'Tab' })
    expect(onSizes).toHaveBeenCalledTimes(1)
  })
})
