import { collectBorderClusters } from "../src/core/game/BorderClusters";
import { PagedGameMap } from "../src/core/game/PagedGameMap";
import { TileSet } from "../src/core/game/TileSet";
import { tileTraversalScratch } from "../src/core/game/TileTraversalScratch";
import { referenceBorderClusters } from "../tests/util/referenceBorderClusters";
const width = 1024,
  height = 1024;
const map = PagedGameMap.fromRowMajor(
  width,
  height,
  256,
  new Uint8Array(width * height).fill(128),
  width * height,
);
for (const kind of ["fragmented", "long-fronts", "dense"]) {
  const tiles = new TileSet();
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (
        kind === "dense"
          ? x < 256 && y < 256
          : kind === "long-fronts"
            ? x % 64 === 0 || y % 64 === 0
            : x % 4 === 0 && y % 4 === 0
      )
        tiles.add(y * width + x);
    }
  const oldScratch = tileTraversalScratch({} as never),
    newScratch = tileTraversalScratch({} as never);
  const measure = (
    fn: typeof collectBorderClusters,
    scratch: typeof oldScratch,
  ) => {
    const start = performance.now();
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += fn(map, tiles, scratch).length;
    return { ms: (performance.now() - start) / 10, sum };
  };
  for (let i = 0; i < 5; i++) {
    measure(referenceBorderClusters, oldScratch);
    measure(collectBorderClusters, newScratch);
  }
  const before = [],
    after = [];
  for (let i = 0; i < 5; i++) {
    before.push(measure(referenceBorderClusters, oldScratch).ms);
    after.push(measure(collectBorderClusters, newScratch).ms);
  }
  before.sort((a, b) => a - b);
  after.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      kind,
      borders: tiles.size,
      beforeMs: before[2],
      afterMs: after[2],
      speedup: before[2] / after[2],
    }),
  );
}
