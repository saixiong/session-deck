import type { ComponentChildren } from 'preact'

interface Props {
  id: string
  title: string
  subtitle?: string | undefined
  count: number
  icon: string
  /** Suggested/Live shelves are visually quieter than the curated section. */
  quiet?: boolean
  actions?: ComponentChildren
  collapsed: boolean
  onToggle: (open: boolean) => void
  children: ComponentChildren
}

/**
 * A dashboard section. The curated section always renders, even when empty —
 * the empty state is the onboarding (Snippbot Dashboard D9). Collapse state
 * is owned by the host's prefs so every window agrees.
 */
export function Section({
  id,
  title,
  subtitle,
  count,
  icon,
  quiet,
  actions,
  collapsed,
  onToggle,
  children,
}: Props) {
  const open = !collapsed
  const headingId = `section-${id}`
  return (
    <section class={`section${quiet ? ' section--quiet' : ''}`} aria-labelledby={headingId}>
      <header class="section__header">
        <h2 class="section__title" id={headingId}>
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
            onClick={() => onToggle(!open)}
          >
            <span class={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden="true" />
          </button>
        </div>
      </header>
      {open ? <div class="section__body">{children}</div> : null}
    </section>
  )
}
