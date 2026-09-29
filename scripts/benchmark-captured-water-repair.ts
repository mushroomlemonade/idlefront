// Read-only microbenchmark of bounded, private route captures. Never opens a game DB.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { WaterRepairSearch } from "../src/core/pathfinding/algorithms/WaterRepairSearch";

const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: benchmark-captured-water-repair.ts CAPTURE_DIRECTORY",
  );
for (const filename of fs
  .readdirSync(directory)
  .filter((f) => /^route-\d+\.json$/.test(f))
  .sort()
  .slice(0, 20)) {
  const q = JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
  const water = Buffer.from(q.water, "base64"),
    blocks = new Map<number, number>(
      q.blocks.map((b: number, i: number) => [b, i]),
    );
  const map = {
    x: (t: number) => t % q.width,
    y: (t: number) => Math.floor(t / q.width),
    isWater: (t: number) => {
      const x = t % q.width,
        y = Math.floor(t / q.width);
      const b = blocks.get(
        Math.floor(y / 16) * q.blocksWide + Math.floor(x / 16),
      );
      return b !== undefined && water[b * 256 + (y % 16) * 16 + (x % 16)] === 1;
    },
    manhattanDist: (a: number, b: number) =>
      Math.abs((a % q.width) - (b % q.width)) +
      Math.abs(Math.floor(a / q.width) - Math.floor(b / q.width)),
    neighbors4: (t: number, out: number[]) => {
      let n = 0;
      const x = t % q.width;
      if (t >= q.width) out[n++] = t - q.width;
      if (t < (q.height - 1) * q.width) out[n++] = t + q.width;
      if (x !== 0) out[n++] = t - 1;
      if (x !== q.width - 1) out[n++] = t + 1;
      return n;
    },
  };
  const corridor = new Set<number>(q.blocks);
  const baseline = new WaterRepairSearch(map, false),
    candidate = new WaterRepairSearch(map);
  const run = (finder: WaterRepairSearch) => {
    const before = finder.metrics.expanded,
      t = performance.now();
    const result = finder.search(q.starts, q.to, corridor, q.blocksWide);
    return {
      ms: performance.now() - t,
      expanded: finder.metrics.expanded - before,
      result,
    };
  };
  const old = run(baseline),
    next = run(candidate);
  if (!isDeepStrictEqual(old.result, q.result))
    throw new Error("Captured baseline diverged: " + filename);
  if (!isDeepStrictEqual(next.result, old.result))
    throw new Error("Exact route regression: " + filename);
  if (next.result)
    for (let i = 1; i < next.result.length; i++) {
      if (map.manhattanDist(next.result[i - 1], next.result[i]) !== 1)
        throw new Error("Nonadjacent route");
      if (
        i < next.result.length - 1 &&
        !map.isWater(next.result[i]) &&
        !q.starts.includes(next.result[i])
      )
        throw new Error("Dry crossing");
    }
  const before: number[] = [],
    after: number[] = [];
  for (let i = 0; i < 5; i++) {
    if (i % 2) {
      after.push(run(candidate).ms);
      before.push(run(baseline).ms);
    } else {
      before.push(run(baseline).ms);
      after.push(run(candidate).ms);
    }
  }
  before.sort((a, b) => a - b);
  after.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      filename,
      width: q.width,
      height: q.height,
      corridorBlocks: q.blocks.length,
      capturedMs: q.ms,
      oldLength: old.result?.length ?? null,
      newLength: next.result?.length ?? null,
      oldExpanded: old.expanded,
      newExpanded: next.expanded,
      baselineMs: before[2],
      candidateMs: after[2],
      speedup: before[2] / after[2],
    }),
  );
}
