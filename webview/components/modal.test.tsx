import { cleanup, fireEvent, render } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.getElementById('outside')?.remove()
})

/** An element outside the dialog, standing in for the editor the user was typing in. */
function outside(): HTMLInputElement {
  const input = document.createElement('input')
  input.id = 'outside'
  document.body.append(input)
  input.focus()
  return input
}

describe('Modal focus handling', () => {
  it('leaves focus alone when the parent re-renders with a new onClose', () => {
    const input = outside()
    // Installed before the render so the effect captures the spied element.
    const focus = vi.spyOn(input, 'focus')
    const { rerender } = render(
      <Modal title="Review sessions" onClose={() => {}}>
        <p>body</p>
      </Modal>
    )
    // The host pushes state several times a second while an analysis runs,
    // and each push re-renders the dashboard with a fresh inline arrow.
    for (let i = 0; i < 5; i++) {
      rerender(
        <Modal title="Review sessions" onClose={() => {}}>
          <p>body {i}</p>
        </Modal>
      )
    }
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('does not focus the webview body on a re-render when nothing here is focused', () => {
    // The real shape of the bug: the user is typing in another editor, so the
    // webview's activeElement is <body>. Focusing it hands the iframe the
    // caret and the keystroke lands nowhere.
    const focus = vi.spyOn(document.body, 'focus')
    const { rerender } = render(
      <Modal title="Review sessions" onClose={() => {}}>
        <p>body</p>
      </Modal>
    )
    for (let i = 0; i < 5; i++) {
      rerender(
        <Modal title="Review sessions" onClose={() => {}}>
          <p>body {i}</p>
        </Modal>
      )
    }
    expect(focus).not.toHaveBeenCalled()
  })

  it('still closes on Escape using the latest handler after a re-render', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <Modal title="Review sessions" onClose={first}>
        <p>body</p>
      </Modal>
    )
    rerender(
      <Modal title="Review sessions" onClose={second}>
        <p>body</p>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('hands focus back to the opener when it closes', () => {
    const opener = document.createElement('button')
    opener.id = 'outside'
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(
      <Modal title="Review sessions" onClose={() => {}}>
        <p>body</p>
      </Modal>
    )
    unmount()
    expect(document.activeElement).toBe(opener)
  })

  it('does not pull focus back into the webview when the webview does not have it', () => {
    const opener = document.createElement('button')
    opener.id = 'outside'
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(
      <Modal title="Review sessions" onClose={() => {}}>
        <p>body</p>
      </Modal>
    )
    // The user has clicked into another editor: our iframe is not focused.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const openerFocus = vi.spyOn(opener, 'focus')
    unmount()
    expect(openerFocus).not.toHaveBeenCalled()
  })

  it('does not focus a previous element that has left the DOM', () => {
    const opener = document.createElement('button')
    opener.id = 'outside'
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(
      <Modal title="Review sessions" onClose={() => {}}>
        <p>body</p>
      </Modal>
    )
    const openerFocus = vi.spyOn(opener, 'focus')
    opener.remove()
    unmount()
    expect(openerFocus).not.toHaveBeenCalled()
  })
})
