import type { StatTileData } from '../../src/shared/messages'

/** One shared tile for the strip and, later, the Review modal's cost tile. */
export function StatTile({ tile }: { tile: StatTileData }) {
  return (
    <div class="stat" title={tile.tooltip}>
      <div class="stat__label">{tile.label}</div>
      <div class="stat__value">{tile.value}</div>
      {tile.hint ? <div class="stat__hint">{tile.hint}</div> : null}
    </div>
  )
}

export function StatStrip({ tiles }: { tiles: StatTileData[] }) {
  return (
    <section class="stats" aria-label="Overview">
      {tiles.map((tile) => (
        <StatTile key={tile.id} tile={tile} />
      ))}
    </section>
  )
}
