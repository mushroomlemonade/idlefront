import { PagedGameMap } from "../src/core/game/PagedGameMap";
import { FailedRouteCache } from "../src/core/pathfinding/transformers/FailedRouteCache";
import { WaterRefinementTransformer } from "../src/core/pathfinding/transformers/WaterRefinementTransformer";
const width = 256,
  height = 128,
  y = 64;
const terrain = new Uint8Array(width * height).fill(32);
for (let row = 0; row < height; row++) terrain[row * width + 128] = 128;
const map = PagedGameMap.fromRowMajor(width, height, 64, terrain, height);
const route = Array.from({ length: width }, (_, x) => y * width + x);
const from = route[0],
  to = route.at(-1)!;
const repair = new WaterRefinementTransformer({ findPath: () => route }, map);
const cached = new FailedRouteCache(
  repair,
  () => "unchanged-terrain-and-graph",
);
for (let i = 0; i < 3; i++) repair.findPath(from, to);
const start = performance.now();
for (let i = 0; i < 30; i++)
  if (repair.findPath(from, to) !== null)
    throw new Error("Expected blocked route");
const baselineMs = performance.now() - start;
const next = performance.now();
for (let i = 0; i < 30; i++)
  if (cached.findPath(from, to) !== null)
    throw new Error("Changed route result");
const cachedMs = performance.now() - next;
console.log(
  JSON.stringify({
    scenario: "30 retries of one unchanged blocked journey",
    baselineMs,
    cachedMs,
    speedup: baselineMs / cachedMs,
    metrics: cached.metrics,
  }),
);
