import { describe, expect, it } from "vitest";
import { collectBorderClusters } from "../../../src/core/game/BorderClusters";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { TileSet } from "../../../src/core/game/TileSet";
import { tileTraversalScratch } from "../../../src/core/game/TileTraversalScratch";
import { referenceBorderClusters } from "../../util/referenceBorderClusters";

describe.each([false, true])("exact border traversal, paged=%s", (paged) => {
  it("preserves component and tile order through random edits and generation wrap", () => {
    const w = 81,
      h = 63,
      terrain = new Uint8Array(w * h).fill(128);
    const map = paged
      ? PagedGameMap.fromRowMajor(w, h, 16, terrain, w * h)
      : new GameMapImpl(w, h, terrain, w * h);
    const borders = new TileSet();
    const actual = tileTraversalScratch({} as never),
      reference = tileTraversalScratch({} as never);
    let seed = 19;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    expect(collectBorderClusters(map, borders, actual)).toEqual([]);
    for (let round = 0; round < 150; round++) {
      for (let i = 0; i < 160; i++) {
        const tile = random() % (w * h);
        if (random() % 3 === 0) borders.delete(tile);
        else borders.add(tile);
      }
      if (round === 80) actual.gen = reference.gen = 0xfffffffe;
      expect(collectBorderClusters(map, borders, actual)).toEqual(
        referenceBorderClusters(map, borders, reference),
      );
    }
  });
  it("joins diagonals without wrapping across row edges", () => {
    const terrain = new Uint8Array(25).fill(128);
    const map = paged
      ? PagedGameMap.fromRowMajor(5, 5, 2, terrain, 25)
      : new GameMapImpl(5, 5, terrain, 25);
    const borders = new TileSet();
    [4, 5, 11, 17, 23].forEach((t) => borders.add(t));
    expect(
      collectBorderClusters(map, borders, tileTraversalScratch({} as never)),
    ).toEqual([[4], [5, 11, 17, 23]]);
  });
  it("matches every small border mask, including one-row and one-column worlds", () => {
    for (const [w, h] of [
      [1, 1],
      [1, 8],
      [8, 1],
      [3, 3],
    ]) {
      const terrain = new Uint8Array(w * h).fill(128);
      const map = paged
        ? PagedGameMap.fromRowMajor(w, h, 2, terrain, w * h)
        : new GameMapImpl(w, h, terrain, w * h);
      const actual = tileTraversalScratch({} as never);
      const reference = tileTraversalScratch({} as never);
      for (let mask = 0; mask < 1 << (w * h); mask++) {
        const borders = new TileSet();
        // Reverse insertion order also exercises order-dependent DFS roots.
        for (let tile = w * h - 1; tile >= 0; tile--)
          if (mask & (1 << tile)) borders.add(tile);
        expect(collectBorderClusters(map, borders, actual)).toEqual(
          referenceBorderClusters(map, borders, reference),
        );
      }
    }
  });
});
