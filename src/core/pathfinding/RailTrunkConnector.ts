import type { Game } from "../game/Game";
import type { RailPathFinderService } from "../game/RailNetworkImpl";
import type { Railroad } from "../game/Railroad";

/** Reuse a real, still-connected trunk's tile geometry. The resulting normal
 * railroad remains registered in the spatial grid and can be split/destroyed.
 * No virtual indestructible edge or separate movement implementation. */
export function railTrunkConnection(
  game: Game,
  native: RailPathFinderService,
  from: number,
  to: number,
  candidates: Iterable<Railroad>,
): number[] | null {
  const config = game.config().gameConfig().tradeCorridors;
  const direct = game.manhattanDist(from, to);
  if (!config || direct < 48) return null;
  let best:
    { rail: Railroad; a: number; b: number; length: number } | undefined;
  let examined = 0;
  for (const rail of candidates) {
    if (++examined > 32) break;
    if (
      rail.trips < config.hotTrips ||
      game.ticks() - rail.lastTripTick > config.idleSeconds * 10 ||
      !rail.from.isActive() ||
      !rail.to.isActive() ||
      rail.from.getRailroadTo(rail.to) !== rail
    )
      continue;
    let a = -1,
      b = -1,
      da = 25,
      db = 25;
    const stride = Math.max(1, Math.ceil((rail.tiles.length - 1) / 64));
    for (let i = 0; i < rail.tiles.length + stride; i += stride) {
      const k = Math.min(i, rail.tiles.length - 1),
        tile = rail.tiles[k];
      const start = game.manhattanDist(from, tile),
        end = game.manhattanDist(to, tile);
      if (start < da) {
        da = start;
        a = k;
      }
      if (end < db) {
        db = end;
        b = k;
      }
    }
    const length = da + db + Math.abs(b - a);
    if (a < 0 || b < 0 || a === b || length > direct * 1.25) continue;
    if (!best || length < best.length) best = { rail, a, b, length };
  }
  if (!best) return null;
  const { rail, a, b } = best;
  const first =
    from === rail.tiles[a] ? [from] : native.findTilePath(from, rail.tiles[a]);
  if (!first.length || first.length > 49) return null;
  const last =
    to === rail.tiles[b] ? [to] : native.findTilePath(rail.tiles[b], to);
  if (!last.length || last.length > 49) return null;
  const middle = rail.tiles.slice(Math.min(a, b), Math.max(a, b) + 1);
  if (a > b) middle.reverse();
  const joined = [...first, ...middle.slice(1), ...last.slice(1)];
  if (
    joined[0] !== from ||
    joined[joined.length - 1] !== to ||
    joined.length - 1 > direct * 1.25
  )
    return null;
  return joined;
}
