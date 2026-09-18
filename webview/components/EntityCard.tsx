import type { ComponentChildren } from 'preact'
import type { CardDetail, FavoriteCard } from '../../src/shared/cards'
import { formatTimeDistance } from '../../src/shared/cards'
import { post } from '../vscodeApi'

/**
 * One card component for every entity type (spec §6): the resolver decides
 * what a card can show; the UI never learns what a "session" is. Rendered as
 * a tile in the grid and as a wide row in the list — the row has room for the
 * preview, which is the only way to tell two similarly titled sessions apart.
 */
export interface EntityCardProps {
  card: FavoriteCard
  variant: 'tile' | 'row'
  verbose: boolean
  starred: boolean
  /** Quieter surface for the Live / Suggested shelves. */
  quiet?: boolean
  /** Extra actions rendered in the action row (Remove, etc.). */
  actions?: ComponentChildren
  /** A small clickable chip under the title — the review score on favorites. */
  badge?: CardBadge | undefined
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
  onDragOver?: (e: DragEvent) => void
  onDrop?: (e: DragEvent) => void
  onDragEnd?: () => void
  dropTarget?: boolean
}

export interface CardBadge {
  text: string
  title: string
  tone: 'low' | 'mid' | 'high' | 'warn' | 'plain'
  onClick: () => void
}

export function EntityCard(props: EntityCardProps) {
  const { card, variant, verbose, starred, quiet, actions, badge } = props
  const open = (target?: 'window' | 'terminal') =>
    post({
      type: 'open',
      entityType: card.entityType,
      entityId: card.entityId,
      ...(target ? { target } : {}),
    })
  const toggle = () =>
    post({
      type: 'toggleFavorite',
      entityType: card.entityType,
      entityId: card.entityId,
      label: card.title,
    })
  const relative = formatTimeDistance(card.updatedAt)
  const classes = [
    'card',
    `card--${variant}`,
    quiet ? 'card--quiet' : '',
    starred ? 'card--starred' : '',
    props.dropTarget ? 'card--drop' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <article
      class={classes}
      draggable={props.draggable ?? false}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
      data-entity-id={card.entityId}
    >
      <header class="card__head">
        <button class="card__title" type="button" title={card.title} onClick={() => open()}>
          {card.status ? (
            <span
              class={`dot dot--${card.statusVariant ?? 'default'}`}
              title={card.status}
              aria-label={card.status}
            />
          ) : null}
          <span class="card__title-text">{card.title}</span>
        </button>
        <button
          class={`star${starred ? ' star--on' : ''}`}
          type="button"
          aria-pressed={starred}
          aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
          title={starred ? 'Remove from favorites' : 'Add to favorites'}
          onClick={toggle}
        >
          <span
            class={`codicon codicon-${starred ? 'star-full' : 'star-empty'}`}
            aria-hidden="true"
          />
        </button>
      </header>
      <div class="card__sub">
        {card.subtitle ? <span>{card.subtitle}</span> : null}
        {card.subtitle && relative ? <span aria-hidden="true"> · </span> : null}
        {relative ? <span title={card.updatedAt ?? undefined}>{relative}</span> : null}
        {badge ? (
          <button
            class={`badge badge--${badge.tone}`}
            type="button"
            title={badge.title}
            onClick={badge.onClick}
          >
            <span class="codicon codicon-checklist" aria-hidden="true" /> {badge.text}
          </button>
        ) : null}
      </div>
      {verbose && card.preview ? (
        <p class={`card__preview${variant === 'tile' || quiet ? ' card__preview--clamp' : ''}`}>
          {card.preview}
        </p>
      ) : null}
      {card.match ? (
        // Shown regardless of Verbose: it is the reason this card is on the page.
        <p class="card__match" title="This word was found in the transcript, not the title">
          <span class="codicon codicon-search" aria-hidden="true" />{' '}
          <span class="card__match-label">matched in transcript</span> {card.match.snippet}
        </p>
      ) : null}
      {verbose && !quiet && card.details.length ? <DetailChips details={card.details} /> : null}
      <footer class="card__actions">
        <button class="button" type="button" onClick={() => open()}>
          <span class="codicon codicon-go-to-file" aria-hidden="true" /> Open
        </button>
        <button
          class="control control--icon"
          type="button"
          title="Open in new window"
          aria-label="Open in new window"
          onClick={() => open('window')}
        >
          <span class="codicon codicon-empty-window" aria-hidden="true" />
        </button>
        {actions}
      </footer>
    </article>
  )
}

export function DetailChips({ details }: { details: CardDetail[] }) {
  return (
    <ul class="chips" aria-label="Details">
      {details.map((d, i) => (
        <li class="chip" key={`${d.label}-${i}`} title={d.label}>
          <span class="chip__label">{d.label}</span>
          {d.kind === 'link' && d.href ? (
            <button
              class="link"
              type="button"
              onClick={() => post({ type: 'openExternal', url: d.href! })}
            >
              {d.value}
            </button>
          ) : (
            <span class="chip__value">
              {d.kind === 'datetime' ? formatDateTime(d.value) : d.value}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** ISO → local date/time; the host cannot know the viewer's zone. */
export function formatDateTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The dimmed card for a favorite whose entity is gone (Snippbot D6). */
export function MissingCard({
  label,
  id,
  variant,
}: {
  label: string
  id: string
  variant: 'tile' | 'row'
}) {
  return (
    <article
      class={`card card--${variant} card--missing`}
      aria-label={`${label} (no longer available)`}
    >
      <header class="card__head">
        <span class="card__title card__title--static">
          <span class="codicon codicon-warning" aria-hidden="true" />{' '}
          <span class="card__title-text">{label}</span>
        </span>
      </header>
      <div class="card__sub">No longer on disk</div>
      <footer class="card__actions">
        <button class="button" type="button" onClick={() => post({ type: 'removeFavorite', id })}>
          <span class="codicon codicon-trash" aria-hidden="true" /> Remove
        </button>
      </footer>
    </article>
  )
}
