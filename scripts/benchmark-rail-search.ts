import { isDeepStrictEqual } from "node:util";
import { GameMapImpl } from "../src/core/game/GameMap";
import { AStar } from "../src/core/pathfinding/algorithms/AStar";
import {
  AStarRail,
  RailAdapter,
} from "../src/core/pathfinding/algorithms/AStar.Rail";

const w = 1024,
  h = 256,
  terrain = new Uint8Array(w * h).fill(128);
for (let y = 0; y < h; y++)
  for (let x = 502; x < 522; x++) terrain[y * w + x] = 0;
const map = new GameMapImpl(w, h, terrain, 0);
const boot = performance.now(),
  optimized = new AStarRail(map);
const prepareMs = performance.now() - boot;
const old = new AStar({ adapter: new RailAdapter(map) });
for (const scenario of ["disconnected", "connected"]) {
  const queries = Array.from({ length: 12 }, (_, i) => [
    w * (120 + i) + 20,
    w * (125 + i) + (scenario === "disconnected" ? 900 : 480),
  ]);
  for (const [from, to] of queries)
    if (
      !isDeepStrictEqual(old.findPath(from, to), optimized.findPath(from, to))
    )
      throw new Error("Rail route changed");
  const measure = (finder: typeof old | typeof optimized) => {
    const at = performance.now();
    for (const [from, to] of queries) finder.findPath(from, to);
    return performance.now() - at;
  };
  const before: number[] = [],
    after: number[] = [];
  for (let i = 0; i < 5; i++) {
    if (i % 2) {
      after.push(measure(optimized));
      before.push(measure(old));
    } else {
      before.push(measure(old));
      after.push(measure(optimized));
    }
  }
  before.sort((a, b) => a - b);
  after.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      scenario,
      queries: queries.length,
      prepareMs,
      beforeMs: before[2],
      afterMs: after[2],
      metrics: optimized.metrics,
    }),
  );
}
