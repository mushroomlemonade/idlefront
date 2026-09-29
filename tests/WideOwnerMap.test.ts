import { describe, expect, it } from "vitest";
import { GameMapImpl } from "../src/core/game/GameMap";
import { packTileState } from "../src/core/game/OwnerIdCodec";
import { PagedGameMap } from "../src/core/game/PagedGameMap";

const makeFlat = (wide: boolean) =>
  new GameMapImpl(
    16001,
    1,
    new Uint8Array(16001).fill(128),
    16001,
    undefined,
    wide,
  );
const makePaged = (wide: boolean) =>
  new PagedGameMap(
    16001,
    1,
    4096,
    Array.from({ length: 4 }, (_, pageX) => {
      const width = Math.min(4096, 16001 - pageX * 4096);
      return {
        pageX,
        pageY: 0,
        width,
        height: 1,
        terrain: new Uint8Array(width).fill(128),
      };
    }),
    16001,
    wide,
  );

describe.each([makeFlat, makePaged])("wide-owner map storage", (make) => {
  it("keeps 16000 simultaneous distinct owners through wire transfer and capture", () => {
    const map = make(true),
      copy = make(true);
    for (let tile = 1; tile <= 16000; tile++) {
      map.setOwnerID(tile, tile);
      map.setFallout(tile, tile % 2 === 0);
      map.setDefenseBonus(tile, tile % 3 === 0);
      copy.updateTile(
        tile,
        packTileState(map.tileState(tile), map.terrainByte(tile)),
      );
    }
    for (let tile = 1; tile <= 16000; tile++) {
      expect(copy.ownerID(tile)).toBe(tile);
      expect(copy.hasFallout(tile)).toBe(tile % 2 === 0);
      expect(copy.hasDefenseBonus(tile)).toBe(tile % 3 === 0);
      expect(copy.terrainByte(tile)).toBe(128);
    }
    map.setOwnerID(1, 65535);
    expect(map.ownerID(1)).toBe(65535);
    map.setOwnerID(1, 4096);
    expect(map.ownerID(1)).toBe(4096);
    map.setOwnerID(1, 0);
    expect(map.hasOwner(1)).toBe(false);
    expect(copy.numTilesWithFallout()).toBe(8000);
  });
  it("keeps legacy storage and fails closed on unsupported owner IDs", () => {
    const map = make(false);
    expect(map.tilePages()[0].state).toBeInstanceOf(Uint16Array);
    expect(() => map.setOwnerID(1, 4096)).toThrow();
    expect(() => map.updateTile(1, packTileState(0x10000, 128))).toThrow();
    expect(map.ownerID(1)).toBe(0);
  });
});
