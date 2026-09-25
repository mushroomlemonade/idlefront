import { describe, expect, it } from "vitest";
import { buildSparseRailroadSegments } from "../../../../src/client/render/gl/passes/SparseRailroadPass";

describe("paged railroad geometry", () => {
  it("turns sparse straight and corner rail tiles into visible segments", () => {
    const rails = new Map<number, number>([
      [21, 1], // vertical at x=1, y=2
      [22, 2], // horizontal at x=2, y=2
      [23, 3], // top-left corner at x=3, y=2
    ]);
    const segments = buildSparseRailroadSegments(
      rails,
      10,
      () => 7,
      (ref) => ref === 22,
    );

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({
      startX: 1.5,
      startY: 2,
      endX: 1.5,
      endY: 3,
      ownerID: 7,
      isWater: false,
    });
    expect(segments[1]).toMatchObject({
      startX: 2,
      startY: 2.5,
      endX: 3,
      endY: 2.5,
      isWater: true,
    });
    expect(segments.slice(2)).toEqual([
      {
        startX: 3.5,
        startY: 2.5,
        endX: 3.5,
        endY: 2,
        ownerID: 7,
        isWater: false,
      },
      {
        startX: 3.5,
        startY: 2.5,
        endX: 3,
        endY: 2.5,
        ownerID: 7,
        isWater: false,
      },
    ]);
  });

  it("ignores cleared and invalid sparse entries", () => {
    expect(
      buildSparseRailroadSegments(
        new Map([
          [11, 0],
          [12, 7],
        ]),
        10,
      ),
    ).toEqual([]);
  });
});
