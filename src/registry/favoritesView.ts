import type { FavoriteGroup, FavoriteItem } from '../shared/cards'
import type { Favorite } from '../store/FavoritesStore'
import type { ResolverRegistry } from './types'

/**
 * Join favorites with their cards, one hydrate() call per type (never one per
 * favorite). A favorite whose entity is gone renders as `missing` rather than
 * vanishing (Snippbot D6). A favorite of a type with no registered resolver is
 * kept as missing too, so a row written by a newer build survives a downgrade.
 */
export function buildFavoriteGroups(
  favorites: Favorite[],
  registry: ResolverRegistry
): FavoriteGroup[] {
  const byType = new Map<string, Favorite[]>()
  for (const f of favorites) {
    const list = byType.get(f.entity_type) ?? []
    list.push(f)
    byType.set(f.entity_type, list)
  }
  const groups: FavoriteGroup[] = []
  for (const resolver of registry.all()) {
    const rows = byType.get(resolver.entityType) ?? []
    const cards = resolver.hydrate(rows.map((r) => r.entity_id))
    const items: FavoriteItem[] = rows
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((row) => {
        const card = cards.get(row.entity_id) ?? null
        return {
          id: row.id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          label: row.label,
          note: row.note,
          sortOrder: row.sort_order,
          createdAt: row.created_at,
          card,
          missing: card === null,
        }
      })
    groups.push({
      entityType: resolver.entityType,
      label: resolver.label,
      icon: resolver.icon,
      items,
    })
    byType.delete(resolver.entityType)
  }
  return groups
}
