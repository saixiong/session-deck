import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

interface Props {
  title: string
  onClose: () => void
  /** `wide` for the picker; `full` for the Review modal (full height, small margin). */
  width?: 'wide' | 'full'
  /** Rendered in the header, before the close button. */
  headerActions?: ComponentChildren
  children: ComponentChildren
}

/**
 * A focus-trapping overlay dialog. Escape and the backdrop close it. The
 * body is a flex column so a child can own its own scroll region
 * (`flex:1; min-height:0; overflow:auto`) — the exact shape that regressed
 * in Snippbot #852, so it is the contract here, not an afterthought.
 */
export function Modal({ title, onClose, width = 'wide', headerActions, children }: Props) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Tab' && dialog.current) trapTab(e, dialog.current)
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      previous?.focus()
    }
  }, [onClose])
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        class={`modal modal--${width}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialog}
      >
        <header class="modal__header">
          <h2 class="modal__title">{title}</h2>
          <div class="modal__actions">
            {headerActions}
            <button
              class="control control--icon"
              type="button"
              aria-label="Close"
              onClick={onClose}
            >
              <span class="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div class="modal__body">{children}</div>
      </div>
    </div>
  )
}

function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  const focusable = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  if (focusable.length === 0) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}
