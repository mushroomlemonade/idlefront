import { z } from "zod";

/** Persisted opt-in: absence leaves existing games and quickplay unchanged. */
export const TradeCorridorsSchema = z
  .object({
    version: z.literal("v1"),
    initialTrips: z.number().finite().min(0.05).max(1),
    matureTrips: z.number().finite().min(0.05).max(4),
    rampSeconds: z.number().int().min(60).max(604800),
    idleSeconds: z.number().int().min(60).max(86400),
    hotTrips: z.number().int().min(2).max(1000),
    // Optional revision switches preserve decisions in saved v1 worlds.
    routing: z.literal("shared-v2").optional(),
    maturation: z.literal("route-v1").optional(),
    warshipRouting: z.literal("shared-v1").optional(),
    economy: z.literal("area-v1").optional(),
  })
  .strict();
export type TradeCorridors = z.infer<typeof TradeCorridorsSchema>;
export function tradeCorridorsForPreset(
  preset: string,
): TradeCorridors | undefined {
  return preset === "longplay" || preset === "idlefront"
    ? {
        version: "v1",
        initialTrips: 0.25,
        matureTrips: 1,
        rampSeconds: preset === "longplay" ? 3600 : 21600,
        idleSeconds: preset === "longplay" ? 1800 : 10800,
        hotTrips: 8,
        routing: "shared-v2",
        maturation: "route-v1",
        warshipRouting: "shared-v1",
        economy: "area-v1",
      }
    : undefined;
}

/** Upper envelope used before a destination is selected; route-specific
 * acceptance then applies the remaining factor without changing native costs. */
export function tradeSpawnRate(
  config: TradeCorridors | undefined,
  tick: number,
): number {
  return config?.maturation === "route-v1"
    ? Math.max(config.initialTrips, config.matureTrips)
    : tradeTripRate(config, tick);
}

/** Small authoritative per-game opportunity history, reconstructed by replay.
 * Evicted/long-idle routes restart quiet; it is not a world-sized traffic map. */
export class TradeRouteMaturation {
  private routes = new Map<string, { born: number; last: number }>();
  constructor(private limit = 4096) {}
  factor(config: TradeCorridors, key: string, tick: number): number {
    if (config.maturation !== "route-v1") return 1;
    let route = this.routes.get(key);
    if (!route || tick - route.last > config.idleSeconds * 10)
      route = { born: tick, last: tick };
    route.last = tick;
    this.routes.delete(key);
    this.routes.set(key, route);
    if (this.routes.size > this.limit)
      this.routes.delete(this.routes.keys().next().value!);
    return (
      tradeTripRate(config, tick - route.born) /
      Math.max(config.initialTrips, config.matureTrips)
    );
  }
}

const maturationByGame = new WeakMap<object, TradeRouteMaturation>();
export function tradeRouteAcceptance(
  game: object,
  config: TradeCorridors | undefined,
  key: string,
  tick: number,
): number {
  if (config?.maturation !== "route-v1") return 1;
  let routes = maturationByGame.get(game);
  if (!routes) {
    routes = new TradeRouteMaturation();
    maturationByGame.set(game, routes);
  }
  return routes.factor(config, key, tick);
}
export function tradeTripRate(
  config: TradeCorridors | undefined,
  tick: number,
): number {
  if (!config) return 1;
  const progress = Math.min(1, Math.max(0, tick / (config.rampSeconds * 10)));
  return (
    config.initialTrips + (config.matureTrips - config.initialTrips) * progress
  );
}
