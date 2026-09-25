import type { Game, Player, TerraNullius } from "../../src/core/game/Game";

// Frozen pre-index query, including its unusual every-tenth-shore ordering.
export function referenceNearby(
  game: Game,
  player: Player,
): (Player | TerraNullius)[] {
  const map = game.map(),
    result = new Set<Player | TerraNullius>();
  const visit = (tile: number) => {
    if (
      !map.isLand(tile) ||
      map.isImpassable(tile) ||
      (!map.hasOwner(tile) && map.hasFallout(tile))
    )
      return;
    if (map.ownerID(tile) !== player.smallID())
      result.add(game.playerBySmallID(map.ownerID(tile)));
  };
  for (const border of player.borderTiles()) map.forEachNeighbor(border, visit);
  let shore = 0;
  for (const tile of player.borderTiles()) {
    if (!map.isShore(tile) || shore++ % 10 !== 0) continue;
    const x = map.x(tile),
      y = map.y(tile);
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      const x1 = x + dx,
        y1 = y + dy,
        nx = x + dx * 5,
        ny = y + dy * 5;
      if (
        map.isValidCoord(x1, y1) &&
        map.isWater(map.ref(x1, y1)) &&
        map.isValidCoord(nx, ny)
      )
        visit(map.ref(nx, ny));
    }
  }
  return [...result];
}
