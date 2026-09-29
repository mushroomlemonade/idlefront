import { UnitType, type Game, type Player, type Unit } from "./Game";
const caches = new WeakMap<Game, { tick: number; ports: Unit[] }>();
export function invalidatePortRoster(game: Game): void {
  caches.delete(game);
}
/** Once-per-tick roster, invalidated immediately for build/capture/deletion.
 * Relations are checked afresh per request, once per port owner (not port).
 * Native player/unit ordering is retained for stable distance-sort ties. */
export function tradePortCandidates(game: Game, owner: Player): Unit[] {
  let cache = caches.get(game);
  if (!cache || cache.tick !== game.ticks()) {
    cache = { tick: game.ticks(), ports: game.units(UnitType.Port) };
    caches.set(game, cache);
  }
  const allowed = new Map<Player, boolean>();
  return cache.ports.filter((port) => {
    const other = port.owner();
    let can = allowed.get(other);
    if (can === undefined) {
      can = other !== owner && other.isAlive() && other.canTrade(owner);
      allowed.set(other, can);
    }
    return can;
  });
}
