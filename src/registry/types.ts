import type { FavoriteCard, FavoriteEntityType } from '../shared/cards'

/**
 * The resolver registry (spec §6, D6). Adding a favoritable kind means adding
 * one resolver; the store, the dashboard groups, the picker and the Suggested
 * shelf all work through this contract.
 */
export interface FavoriteResolver {
  readonly entityType: FavoriteEntityType
  /** Section heading. */
  readonly label: string
  /** Codicon name. */
  readonly icon: string
  /** Batch-resolve ids to cards. Missing ids are absent; the caller marks them `missing`. */
  hydrate(ids: readonly string[]): Map<string, FavoriteCard>
  /** Candidates for the picker. May scan; only runs on an explicit user action. */
  browse(query: string | null, limit: number): { items: FavoriteCard[]; total: number }
  /** Recently active entities of this type, minus `exclude`, for the Suggested shelf. */
  suggest(limit: number, exclude: ReadonlySet<string>): FavoriteCard[]
}

export class ResolverRegistry {
  private readonly resolvers = new Map<FavoriteEntityType, FavoriteResolver>()

  register(resolver: FavoriteResolver): void {
    this.resolvers.set(resolver.entityType, resolver)
  }

  get(entityType: FavoriteEntityType): FavoriteResolver | undefined {
    return this.resolvers.get(entityType)
  }

  /** Registry order is section order on the dashboard. */
  all(): FavoriteResolver[] {
    return [...this.resolvers.values()]
  }
}
