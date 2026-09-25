import assert from "node:assert/strict";
import { TileSet } from "../src/core/game/TileSet";

// Both operations are verified-unique, as in GameImpl.conquer. This is an
// isolated insertion/removal benchmark, not a simulation throughput claim.
const values = Array.from(
  { length: 200000 },
  (_, i) => (i % 1000) + Math.floor(i / 1000) * 21344,
);
const measure = (known: boolean) => {
  const set = new TileSet();
  const start = performance.now();
  for (const tile of values) {
    if (known) set.addKnownAbsent(tile);
    else set.add(tile);
  }
  for (let i = 0; i < values.length; i += 2) set.delete(values[i]);
  for (let i = 0; i < values.length; i += 2) {
    if (known) set.addKnownAbsent(values[i]);
    else set.add(values[i]);
  }
  return { ms: performance.now() - start, result: [...set] };
};
measure(false);
measure(true);
const before: number[] = [],
  after: number[] = [];
for (let repeat = 0; repeat < 7; repeat++) {
  const first = measure(Boolean(repeat % 2)),
    second = measure(!(repeat % 2));
  const old = repeat % 2 ? second : first,
    optimized = repeat % 2 ? first : second;
  assert.deepEqual(old.result, optimized.result);
  before.push(old.ms);
  after.push(optimized.ms);
}
console.log(
  JSON.stringify({
    tiles: values.length,
    insertions: values.length * 1.5,
    beforeMedianMs: before.sort((a, b) => a - b)[3],
    afterMedianMs: after.sort((a, b) => a - b)[3],
  }),
);
