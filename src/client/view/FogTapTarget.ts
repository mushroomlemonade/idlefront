/** A small input tolerance, not an information-revealing query into the fog. */
export function resolveFogTapTarget(
  tile: number,
  map: {
    x(tile: number): number;
    y(tile: number): number;
    ref(x: number, y: number): number;
    isValidCoord(x: number, y: number): boolean;
    isTileVisible(tile: number): boolean;
    isLand(tile: number): boolean;
    ownerID(tile: number): number;
  },
  self: number,
): number | null {
  if (map.isTileVisible(tile)) return tile;
  const x = map.x(tile), y = map.y(tile);
  let target: number | null = null;
  let distance = 65;
  // Bounded work on a tap only. Never treat redacted ownership as wilderness.
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const squared = dx * dx + dy * dy;
      if (squared > 64 || squared >= distance || !map.isValidCoord(x + dx, y + dy)) continue;
      const candidate = map.ref(x + dx, y + dy);
      if (!map.isTileVisible(candidate) || !map.isLand(candidate) || map.ownerID(candidate) === self) continue;
      target = candidate;
      distance = squared;
    }
  }
  return target;
}
