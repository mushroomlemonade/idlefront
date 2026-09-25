import { describe, expect, it } from "vitest";
import { GameMapImpl, type GameMap } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import {
  genTerrainFromPages,
  type PagedMapMetadata,
} from "../../../src/core/game/TerrainMapLoader";

const LAND = 0x80 | 7;
const OCEAN = 0x20;

function maps(width = 7, height = 5, pageSize = 3) {
  const terrain = new Uint8Array(width * height);
  for (let ref = 0; ref < terrain.length; ref++) {
    terrain[ref] = ref % 5 === 0 ? OCEAN : LAND;
  }
  const land = terrain.reduce(
    (count, byte) => count + (byte & 0x80 ? 1 : 0),
    0,
  );
  return {
    classic: new GameMapImpl(width, height, terrain.slice(), land),
    paged: PagedGameMap.fromRowMajor(width, height, pageSize, terrain, land),
  };
}

function snapshot(map: GameMap) {
  const result: Array<{
    terrain: number;
    state: number;
    neighbors: number[];
    border: boolean;
  }> = [];
  map.forEachTile((ref) => {
    result.push({
      terrain: map.terrainByte(ref),
      state: map.tileState(ref),
      neighbors: map.neighbors(ref),
      border: map.isBorder(ref),
    });
  });
  return result;
}

describe("PagedGameMap", () => {
  it("preserves neighbor order at every edge and page seam", () => {
    for (const [width, height] of [
      [1, 1],
      [1, 5],
      [5, 1],
      [7, 5],
    ]) {
      const { classic, paged } = maps(width, height);
      for (let ref = 0; ref < width * height; ref++) {
        const out: number[] = [];
        const count = paged.neighbors4(ref, out);
        expect(out.slice(0, count)).toEqual(classic.neighbors(ref));
        const expected: number[] = [];
        const actual: number[] = [];
        classic.forEachNeighborWithDiag(ref, (n) => expected.push(n));
        paged.forEachNeighborWithDiag(ref, (n) => actual.push(n));
        expect(actual).toEqual(expected);
      }
    }
  });
  it("matches stock map behavior across horizontal and vertical seams", () => {
    const { classic, paged } = maps();
    const seamRefs = [
      classic.ref(2, 2),
      classic.ref(3, 2),
      classic.ref(5, 2),
      classic.ref(6, 2),
    ];

    for (const ref of seamRefs) {
      classic.setOwnerID(ref, ref + 1);
      paged.setOwnerID(ref, ref + 1);
      classic.setFallout(ref, ref % 2 === 0);
      paged.setFallout(ref, ref % 2 === 0);
    }

    expect(snapshot(paged)).toEqual(snapshot(classic));
    expect(paged.neighbors(paged.ref(2, 2))).toContain(paged.ref(3, 2));
    expect(paged.neighbors(paged.ref(3, 2))).toContain(paged.ref(2, 2));
    expect(paged.neighbors(paged.ref(4, 2))).toContain(paged.ref(4, 3));
  });

  it("supports clipped, non-square, manifest-derived page grids", () => {
    const { paged } = maps(11, 7, 4);
    expect(paged.pageGrid()).toEqual({ width: 3, height: 2 });
    expect(paged.tilePages().map((page) => [page.width, page.height])).toEqual([
      [4, 4],
      [4, 4],
      [3, 4],
      [4, 3],
      [4, 3],
      [3, 3],
    ]);
    expect(paged.tilePages().every((page) => page.state.length <= 16)).toBe(
      true,
    );
    expect(() => paged.tileStateBuffer()).toThrow(/no contiguous/i);
  });

  it("does not change results when input pages arrive out of order", () => {
    const width = 9;
    const height = 6;
    const pageSize = 4;
    const terrain = new Uint8Array(width * height).fill(LAND);
    const canonical = PagedGameMap.fromRowMajor(
      width,
      height,
      pageSize,
      terrain,
      terrain.length,
    );
    const shuffled = new PagedGameMap(
      width,
      height,
      pageSize,
      [...canonical.tilePages()]
        .reverse()
        .map(({ pageX, pageY, width, height, terrain }) => ({
          pageX,
          pageY,
          width,
          height,
          terrain: terrain.slice(),
        })),
      terrain.length,
    );

    for (let ref = 0; ref < terrain.length; ref += 3) {
      canonical.updateTile(ref, ((ref % 31) << 16) | ((ref % 11) + 1));
      shuffled.updateTile(ref, ((ref % 31) << 16) | ((ref % 11) + 1));
    }
    expect(snapshot(shuffled)).toEqual(snapshot(canonical));
  });

  it("scales storage by pages rather than a world-sized state allocation", () => {
    const width = 16 * 8;
    const height = 16 * 8;
    const terrain = new Uint8Array(width * height).fill(LAND);
    const map = PagedGameMap.fromRowMajor(
      width,
      height,
      8,
      terrain,
      terrain.length,
    );

    expect(map.pageGrid()).toEqual({ width: 16, height: 16 });
    expect(map.tilePages()).toHaveLength(256);
    expect(map.tilePages().every((page) => page.state.length === 64)).toBe(
      true,
    );
  });

  it("constructs a paged-v1 map from manifest pages in any order", async () => {
    const metadata: PagedMapMetadata = {
      format: "paged-v1",
      width: 5,
      height: 3,
      num_land_tiles: 15,
      page_size: 3,
      pages_wide: 2,
      pages_high: 1,
      pages: [
        {
          x: 0,
          y: 0,
          width: 3,
          height: 3,
          path: "pages/0-0.bin",
          byte_length: 9,
          sha256: "a",
        },
        {
          x: 1,
          y: 0,
          width: 2,
          height: 3,
          path: "pages/1-0.bin",
          byte_length: 6,
          sha256: "b",
        },
      ],
    };
    const map = await genTerrainFromPages(metadata, [
      { ...metadata.pages[1], terrain: new Uint8Array(6).fill(LAND) },
      { ...metadata.pages[0], terrain: new Uint8Array(9).fill(LAND) },
    ]);

    expect(map.width()).toBe(5);
    expect(map.height()).toBe(3);
    expect(map.isPaged()).toBe(true);
    expect(map.terrainByte(map.ref(3, 1))).toBe(LAND);
  });
});
