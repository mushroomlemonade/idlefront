import { isDeepStrictEqual } from "node:util";
import { PagedGameMap } from "../src/core/game/PagedGameMap";
import { WaterRefinementTransformer } from "../src/core/pathfinding/transformers/WaterRefinementTransformer";
import { ReferenceWaterRefinementTransformer } from "../tests/util/referenceWaterRefinement";
for (const scenario of ["blocked", "detour", "many-blocks"]) {
  const width = 1024,
    height = 256,
    terrain = new Uint8Array(width * height).fill(32);
  for (let y = 0; y < height; y++)
    if (scenario !== "detour" || y !== 135) terrain[y * width + 512] = 128;
  const map = PagedGameMap.fromRowMajor(width, height, 64, terrain, height);
  let path: number[] = [];
  const inner = { findPath: () => path };
  const old = new ReferenceWaterRefinementTransformer(inner, map),
    mapIndex = new WaterRefinementTransformer(inner, map),
    updated = new WaterRefinementTransformer(inner, map);
  // Isolate only the lookup-storage change, with the exact same search code.
  (
    mapIndex as unknown as { repair: { index: Map<number, number> } }
  ).repair.index = new Map<number, number>();
  const queries = Array.from({ length: 12 }, (_, i) => {
    const y = 120 + i;
    return scenario === "many-blocks"
      ? Array.from(
          { length: width },
          (_, x) => ((y + Math.floor(x / 64)) % height) * width + x,
        )
      : Array.from({ length: width }, (_, x) => y * width + x);
  });
  for (const q of queries) {
    path = q;
    if (
      !isDeepStrictEqual(
        old.findPath(q[0], q.at(-1)!),
        updated.findPath(q[0], q.at(-1)!),
      ) ||
      !isDeepStrictEqual(
        mapIndex.findPath(q[0], q.at(-1)!),
        updated.findPath(q[0], q.at(-1)!),
      )
    )
      throw new Error("Route changed");
  }
  const measure = (finder: typeof old) => {
    const start = performance.now();
    for (const q of queries) {
      path = q;
      finder.findPath(q[0], q.at(-1)!);
    }
    return performance.now() - start;
  };
  measure(old);
  measure(mapIndex);
  measure(updated);
  const before = [],
    mapTimes = [],
    after = [];
  for (let i = 0; i < 5; i++) {
    before.push(measure(old));
    // Alternate candidate order to reduce warm-up/order bias.
    if (i % 2 === 0) {
      mapTimes.push(measure(mapIndex));
      after.push(measure(updated));
    } else {
      after.push(measure(updated));
      mapTimes.push(measure(mapIndex));
    }
  }
  before.sort((a, b) => a - b);
  mapTimes.sort((a, b) => a - b);
  after.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      scenario,
      queries: queries.length,
      beforeMs: before[2],
      mapIndexMs: mapTimes[2],
      afterMs: after[2],
      speedup: before[2] / after[2],
      lookupSpeedup: mapTimes[2] / after[2],
    }),
  );
}
