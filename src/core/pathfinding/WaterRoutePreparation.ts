import type { Game } from "../game/Game";

export interface WaterRouteJob {
  from: number;
  to: number;
  route: number[] | null;
}
export type WaterRouteExecutor = (
  jobs: WaterRouteJob[],
) => Promise<(number[] | null)[]>;
const queues = new WeakMap<Game, Map<string, { from: number; to: number }>>();
const enabled = new WeakSet<Game>();
export function enableWaterPreparation(game: Game) {
  enabled.add(game);
}
export function queueWaterPreparation(game: Game, from: number, to: number) {
  if (!enabled.has(game)) return;
  let queue = queues.get(game);
  if (!queue) queues.set(game, (queue = new Map()));
  // Hints are optional, not deferred gameplay. Overflow uses the normal path.
  if (queue.size < 128) queue.set(`${from}:${to}`, { from, to });
}
export function takeWaterPreparation(game: Game) {
  const queue = queues.get(game);
  queues.delete(game);
  return queue ? [...queue.values()] : [];
}
