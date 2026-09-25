import assert from "node:assert/strict";
import { OrderedRoster } from "../src/core/game/OrderedRoster";

// Isolate the measured batch-removal hotspot. Includes one post-batch read;
// excludes setup equally for both implementations. Not a full-game claim.
for (const size of [1000, 5000, 20000]) {
  const count = Math.floor(size / 5);
  const run = (indexed: boolean) => {
    const values = Array.from({ length: size }, (_, i) => i);
    const roster = new OrderedRoster<number>();
    for (const value of values) roster.add(value);
    let array = values;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      if (indexed) roster.delete(i);
      else array = array.filter((value) => value !== i);
    }
    const result = indexed ? roster.snapshot() : array;
    const ms = performance.now() - start;
    assert.deepEqual(result, values.slice(count));
    return ms;
  };
  run(false);
  run(true);
  const old: number[] = [],
    optimized: number[] = [];
  for (let repeat = 0; repeat < 7; repeat++) {
    // Alternate order to reduce a consistent warm-up/order bias.
    if (repeat % 2) {
      optimized.push(run(true));
      old.push(run(false));
    } else {
      old.push(run(false));
      optimized.push(run(true));
    }
  }
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[3];
  console.log(
    JSON.stringify({
      size,
      removals: count,
      filterMedianMs: median(old),
      indexedMedianMs: median(optimized),
    }),
  );
}
