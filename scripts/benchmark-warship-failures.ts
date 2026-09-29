import { performance } from "node:perf_hooks";
import { GameMapImpl } from "../src/core/game/GameMap";
import { WaterRepairSearch } from "../src/core/pathfinding/algorithms/WaterRepairSearch";

// Small SOURCE basin: the previous 4096-expansion reverse proof never ran.
// No revision disables cross-request proofs and reproduces its repeated work.
const width = 256,
  height = 128;
const terrain = new Uint8Array(width * height).fill(32);
for (let y = 0; y < height; y++) terrain[y * width + 8] = 128;
const map = new GameMapImpl(width, height, terrain, height);
const corridor = new Set(
  Array.from({ length: (width * height) / 256 }, (_, i) => i),
);
function run(cached: boolean) {
  const search = new WaterRepairSearch(
    map,
    true,
    cached ? () => "0" : undefined,
  );
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    if (
      search.search([i * width], i * width + 240, corridor, width / 16) !== null
    )
      throw new Error("Unexpected reachable route");
  }
  return { ms: performance.now() - start, ...search.metrics };
}
run(false);
run(true);
const samples = Array.from({ length: 5 }, () => ({
  before: run(false),
  after: run(true),
}));
console.log(
  JSON.stringify(
    {
      fixture:
        "100 different requests from a 1024-tile enclosed basin on a 256x128 map",
      samples,
      limitation: "isolated routing workload, not whole-game TPS",
    },
    null,
    2,
  ),
);
