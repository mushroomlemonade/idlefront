import { TileSet } from "../../../src/core/game/TileSet";

it("known-absent insertion matches general insertion across collisions, tombstones, growth and live iterators", () => {
  const reference = new TileSet(),
    actual = new TileSet();
  let seed = 19;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let batch = 0; batch < 150; batch++) {
    const ri = reference.values(),
      ai = actual.values();
    expect(ai.next()).toEqual(ri.next());
    for (let i = 0; i < 100; i++) {
      const tile = (random() >>> 12) % 2000;
      if ((random() >>> 20) % 3 === 0) {
        expect(actual.delete(tile)).toBe(reference.delete(tile));
      } else if (!reference.has(tile)) {
        reference.add(tile);
        actual.addKnownAbsent(tile);
      }
    }
    expect([...ai]).toEqual([...ri]);
    expect([...actual]).toEqual([...reference]);
    expect(actual.revision).toBe(reference.revision);
    expect(actual.size).toBe(reference.size);
    for (const tile of reference)
      expect(actual.positionOf(tile)).toBe(reference.positionOf(tile));
    // Identical hash storage prevents a subtly different future compaction.
    expect((actual as any).table).toEqual((reference as any).table);
    expect((actual as any).dense).toEqual((reference as any).dense);
    if (batch % 37 === 0) {
      actual.clear();
      reference.clear();
    }
  }
});
