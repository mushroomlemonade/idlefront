import { expect, it } from "vitest";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { FlatBinaryHeap } from "../src/core/execution/utils/FlatBinaryHeap";

it("checkpoints the random stream without consuming or aliasing state", () => {
  for (const seed of [0, 1, -1, 123, 0x7fffffff]) {
    const original = new PseudoRandom(seed);
    for (let i = 0; i < 77; i++) original.next();
    const state = original.snapshot();
    const clone = PseudoRandom.fromSnapshot(state);
    expect(original.snapshot()).toEqual(state);
    for (let i = 0; i < 1000; i++) expect(clone.next()).toBe(original.next());
    expect(clone.snapshot()).toEqual(original.snapshot());
    expect(state).not.toEqual(original.snapshot());
  }
});

it("restores heap storage without re-enqueueing, including duplicate Float32 ties", () => {
  const random = new PseudoRandom(773);
  const heap = new FlatBinaryHeap(4);
  for (let i = 0; i < 1000; i++)
    heap.enqueue(
      random.nextInt(0, 200),
      (i % 2 ? 0 : 16777216) + random.nextInt(0, 12) / 4,
    );
  for (let i = 0; i < 171; i++) heap.dequeue();
  const snapshot = heap.snapshot();
  const clone = FlatBinaryHeap.fromSnapshot(snapshot);
  expect(clone.snapshot()).toEqual(snapshot);
  for (let i = 0; i < 2000; i++) {
    if (!heap.size() || random.nextInt(0, 3)) {
      const tile = random.nextInt(0, 4294836225),
        priority = random.nextInt(0, 8) / 3;
      heap.enqueue(tile, priority);
      clone.enqueue(tile, priority);
    } else expect(clone.dequeue()).toBe(heap.dequeue());
  }
  while (heap.size()) expect(clone.dequeue()).toBe(heap.dequeue());
  expect(snapshot.tiles.length).toBe(829);
  expect(heap.size()).toBe(0);
});
