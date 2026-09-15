import { useMemo, useState } from 'preact/hooks'
import type { FavoriteGroup, FavoriteItem } from '../../src/shared/cards'
import type { DashboardPrefs, ReviewState } from '../../src/shared/messages'
import { post } from '../vscodeApi'
import { deckFor } from '../tipContent'
import { EntityCard, MissingCard } from './EntityCard'
import { Section } from './Section'
import { SectionTipStrip } from './SectionTipStrip'

interface Props {
  group: FavoriteGroup
  prefs: DashboardPrefs
  workspaceKeys: string[]
  onAdd: () => void
  /** Opens the Review modal, scrolled to `focus` when given. */
  onReview?: ((focus: string | null) => void) | undefined
  reviewEnabled: boolean
  /** Cached reports by session id, for the per-card review badge. */
  reviews?: ReviewState['reviews'] | undefined
}

/**
 * One curated section per registered entity type (spec §8.1). Items are
 * grouped by project — the workspace's project first — and ordered by
 * sort_order inside a group. Drag-to-reorder drops `moveFavorite` messages.
 * The tip strip is expanded when the section is empty and collapses behind
 * the lightbulb once it has items, unless the user overrode that.
 */
export function FavoritesSection({
  group,
  prefs,
  workspaceKeys,
  onAdd,
  onReview,
  reviewEnabled,
  reviews,
}: Props) {
  const empty = group.items.length === 0
  const override = prefs.tips[group.entityType]
  const tipsOpen = override ?? empty
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const projects = useMemo(
    () => groupByProject(group.items, workspaceKeys),
    [group.items, workspaceKeys]
  )

  const setTips = (open: boolean) =>
    post({ type: 'setPrefs', prefs: { tips: { ...prefs.tips, [group.entityType]: open } } })

  const drop = (targetId: string | null) => {
    if (dragId && dragId !== targetId)
      post({ type: 'moveFavorite', id: dragId, beforeId: targetId })
    setDragId(null)
    setOverId(null)
  }

  const renderItem = (item: FavoriteItem) => {
    if (!item.card)
      return (
        <MissingCard
          key={item.id}
          label={item.label}
          id={item.id}
          variant={prefs.view === 'grid' ? 'tile' : 'row'}
        />
      )
    const review = reviews?.[item.entityId]
    return (
      <EntityCard
        key={item.id}
        card={item.card}
        variant={prefs.view === 'grid' ? 'tile' : 'row'}
        verbose={prefs.verbose}
        starred
        badge={
          review && onReview
            ? {
                text: `${review.completion !== null ? `${review.completion}% · ` : ''}${review.priority_label}${review.stale ? ' · out of date' : ''}`,
                title: `Review: ${review.summary}`,
                tone: review.stale ? 'warn' : badgeTone(review.completion),
                onClick: () => onReview(item.entityId),
              }
            : undefined
        }
        draggable
        dropTarget={overId === item.id}
        onDragStart={(e) => {
          setDragId(item.id)
          e.dataTransfer?.setData('text/plain', item.id)
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (!dragId) return
          e.preventDefault()
          setOverId(item.id)
        }}
        onDrop={(e) => {
          e.preventDefault()
          drop(item.id)
        }}
        onDragEnd={() => {
          setDragId(null)
          setOverId(null)
        }}
      />
    )
  }

  return (
    <Section
      id={group.entityType}
      title={group.label}
      count={group.items.length}
      icon={group.icon}
      collapsed={prefs.collapsed[group.entityType] ?? false}
      onToggle={(open) =>
        post({
          type: 'setPrefs',
          prefs: { collapsed: { ...prefs.collapsed, [group.entityType]: !open } },
        })
      }
      actions={
        <>
          {onReview ? (
            <button
              class="button button--primary"
              type="button"
              disabled={!reviewEnabled}
              onClick={() => onReview(null)}
              title={reviewEnabled ? undefined : 'Star a session first'}
            >
              <span class="codicon codicon-checklist" aria-hidden="true" /> Review{' '}
              {group.label.toLowerCase()}
            </button>
          ) : null}
          <button class="button" type="button" onClick={onAdd}>
            <span class="codicon codicon-add" aria-hidden="true" /> Add
          </button>
          {!empty ? (
            <button
              class={`control control--icon${tipsOpen ? ' control--active' : ''}`}
              type="button"
              aria-expanded={tipsOpen}
              aria-label={tipsOpen ? 'Hide tips' : 'Show tips'}
              title={tipsOpen ? 'Hide tips' : 'Show tips'}
              onClick={() => setTips(!tipsOpen)}
            >
              <span class="codicon codicon-lightbulb" aria-hidden="true" />
            </button>
          ) : null}
        </>
      }
    >
      {tipsOpen ? (
        <SectionTipStrip
          deck={deckFor(group.entityType, group.label)}
          cta={{ label: 'Add items', onClick: onAdd }}
        />
      ) : null}
      {!empty ? (
        <div class={`favorites favorites--${prefs.view}`}>
          {projects.map((p) => (
            <div class="project" key={p.key}>
              <h3 class="project__title">
                <span class="codicon codicon-folder" aria-hidden="true" /> {p.label}
                <span class="badge">{p.items.length}</span>
                {p.inWorkspace ? <span class="tag">this workspace</span> : null}
              </h3>
              <div
                class={prefs.view === 'grid' ? 'grid' : 'rows'}
                onDragOver={(e) => {
                  if (dragId) e.preventDefault()
                }}
                onDrop={(e) => {
                  // Dropped on the container (past the last card) → move to the end.
                  if ((e.target as HTMLElement).closest('.card')) return
                  e.preventDefault()
                  drop(null)
                }}
              >
                {p.items.map(renderItem)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  )
}

export interface ProjectBucket {
  key: string
  label: string
  inWorkspace: boolean
  items: FavoriteItem[]
}

/** Exported for tests: workspace groups first, then by the newest item, missing last. */
export function groupByProject(items: FavoriteItem[], workspaceKeys: string[]): ProjectBucket[] {
  const buckets = new Map<string, ProjectBucket & { latest: string }>()
  for (const item of items) {
    const key = item.card?.group.key ?? '__missing__'
    const label = item.card?.group.label ?? 'No longer on disk'
    const bucket = buckets.get(key) ?? {
      key,
      label,
      inWorkspace: workspaceKeys.some((w) => key === w || key.startsWith(`${w}/`)),
      items: [],
      latest: '',
    }
    bucket.items.push(item)
    const updated = item.card?.updatedAt ?? ''
    if (updated > bucket.latest) bucket.latest = updated
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, items: [...b.items].sort((a, c) => a.sortOrder - c.sortOrder) }))
    .sort((a, b) => {
      if (a.key === '__missing__') return 1
      if (b.key === '__missing__') return -1
      return (
        Number(b.inWorkspace) - Number(a.inWorkspace) ||
        (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0)
      )
    })
}

function badgeTone(completion: number | null): 'low' | 'mid' | 'high' | 'plain' {
  if (completion === null) return 'plain'
  return completion >= 90 ? 'high' : completion >= 50 ? 'mid' : 'low'
}
