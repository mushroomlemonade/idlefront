import { expect, it } from "vitest";
import { AttackImpl } from "../../../src/core/game/AttackImpl";

it.each([[[]], [[17, 22]]])(
  "preserves attack-border order and count across duplicate additions/removals, initial=%s",
  (initial) => {
    const border = new Set(initial),
      expected = new Set(initial);
    const attack = new AttackImpl(
      "test",
      {} as never,
      {} as never,
      100,
      null,
      border,
      {} as never,
    );
    // Keep the existing constructor behavior even with a caller-provided set.
    let expectedCount = 0,
      seed = 417;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let batch = 0; batch < 100; batch++) {
      const ai = border.values(),
        ri = expected.values();
      expect(ai.next()).toEqual(ri.next());
      for (let i = 0; i < 50; i++) {
        const tile = (random() >>> 8) % 64;
        if (random() % 3 === 0) {
          if (expected.has(tile)) {
            expectedCount--;
            expected.delete(tile);
          }
          attack.removeBorderTile(tile);
        } else {
          if (!expected.has(tile)) {
            expectedCount++;
            expected.add(tile);
          }
          attack.addBorderTile(tile);
        }
        expect(attack.borderSize()).toBe(expectedCount);
      }
      expect([...ai]).toEqual([...ri]);
      expect([...border]).toEqual([...expected]);
      if (batch % 23 === 0) {
        attack.clearBorder();
        expected.clear();
        expectedCount = 0;
        expect(attack.borderSize()).toBe(0);
      }
    }
  },
);
