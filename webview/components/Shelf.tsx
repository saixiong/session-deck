import type { FavoriteCard } from '../../src/shared/cards'
import type { DashboardPrefs } from '../../src/shared/messages'
import { post } from '../vscodeApi'
import { EntityCard } from './EntityCard'
import { Section } from './Section'

interface Props {
  id: 'live' | 'suggested'
  title: string
  subtitle?: string
  icon: string
  cards: FavoriteCard[]
  prefs: DashboardPrefs
  emptyText: string
  /** Suggested hides itself when empty (Snippbot §9.6); Live always renders. */
  hideWhenEmpty?: boolean
}

/**
 * The quieter shelves under the curated section. Every card's primary
 * action is its star: promoting one makes it a real favorite, and it leaves
 * the shelf on the next state push.
 */
export function Shelf({
  id,
  title,
  subtitle,
  icon,
  cards,
  prefs,
  emptyText,
  hideWhenEmpty,
}: Props) {
  if (hideWhenEmpty && cards.length === 0) return null
  return (
    <Section
      id={id}
      title={title}
      subtitle={subtitle}
      count={cards.length}
      icon={icon}
      quiet
      collapsed={prefs.collapsed[id] ?? false}
      onToggle={(open) =>
        post({ type: 'setPrefs', prefs: { collapsed: { ...prefs.collapsed, [id]: !open } } })
      }
    >
      {cards.length === 0 ? (
        <p class="muted">{emptyText}</p>
      ) : (
        <div class={prefs.view === 'grid' ? 'grid grid--shelf' : 'rows'}>
          {cards.map((card) => (
            <EntityCard
              key={card.entityId}
              card={card}
              variant={prefs.view === 'grid' ? 'tile' : 'row'}
              verbose={prefs.verbose}
              starred={false}
              quiet
            />
          ))}
        </div>
      )}
    </Section>
  )
}
