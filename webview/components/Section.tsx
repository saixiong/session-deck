import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'

interface Props {
  title: string
  subtitle?: string
  count: number
  icon: string
  /** Suggested/Live shelves are visually quieter than the curated section. */
  quiet?: boolean
  actions?: ComponentChildren
  children: ComponentChildren
}

/**
 * A dashboard section. Always renders, even when empty — the empty state is
 * the onboarding (Snippbot Dashboard D9). Collapse state is local for now;
 * P3 persists it.
 */
export function Section({ title, subtitle, count, icon, quiet, actions, children }: Props) {
  const [open, setOpen] = useState(true)
  return (
    <section
      class={`section${quiet ? ' section--quiet' : ''}`}
      aria-labelledby={`section-${title}`}
    >
      <header class="section__header">
        <h2 class="section__title" id={`section-${title}`}>
          <span class={`codicon codicon-${icon}`} aria-hidden="true" /> {title}
          <span class="badge" aria-label={`${count} items`}>
            {count}
          </span>
          {subtitle ? <span class="section__subtitle">— {subtitle}</span> : null}
        </h2>
        <div class="section__actions">
          {actions}
          <button
            class="control control--icon"
            type="button"
            aria-expanded={open}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            onClick={() => setOpen((v) => !v)}
          >
            <span class={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden="true" />
          </button>
        </div>
      </header>
      {open ? <div class="section__body">{children}</div> : null}
    </section>
  )
}
