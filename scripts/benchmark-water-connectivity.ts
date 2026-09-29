// Repeat unreachable requests with different origins/destinations in one
// isolated basin. Compares against the previous search-local proof, not old A*.
import { isDeepStrictEqual } from "node:util";
import { GameMapImpl } from "../src/core/game/GameMap";
import { WaterRepairSearch } from "../src/core/pathfinding/algorithms/WaterRepairSearch";
const width = 512,
  height = 256;
const terrain = new Uint8Array(width * height).fill(32);
for (let y = 0; y < height; y++) terrain[y * width + 480] = 128;
const map = new GameMapImpl(width, height, terrain, height);
const blocksWide = width / 16;
const corridor = new Set(
  Array.from({ length: (blocksWide * height) / 16 }, (_, i) => i),
);
let revision = 0;
const baseline = new WaterRepairSearch(map),
  candidate = new WaterRepairSearch(map, true, () => String(revision));
const run = (search: WaterRepairSearch) => {
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    const result = search.search(
      [i * width],
      (i + 100) * width + 490,
      corridor,
      blocksWide,
    );
    if (result !== null) throw new Error("Expected disconnected basin");
  }
  return performance.now() - start;
};
const before = run(baseline),
  after = run(candidate);
const hits = candidate.metrics.connectivityHits;
map.setWater(128 * width + 480);
revision++;
if (
  !isDeepStrictEqual(
    candidate.search([0], width * 128 + 490, corridor, blocksWide),
    baseline.search([0], width * 128 + 490, corridor, blocksWide),
  )
)
  throw new Error("Terrain invalidation changed route");
console.log(
  JSON.stringify({
    fixture: "100 requests into a 7936-tile isolated basin",
    width,
    height,
    baselineMs: before,
    candidateMs: after,
    connectivityHits: hits,
    terrainInvalidationPassed: true,
    limitation:
      "synthetic disconnected-basin mechanism test, not full-game TPS",
  }),
);
