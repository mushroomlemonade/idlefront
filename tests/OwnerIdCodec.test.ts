import { describe, expect, it } from "vitest";
import {
  checkedTileState,
  ownerFromTileState,
  ownerTextureCoordinate,
  packTileState,
  projectedTileState,
  stateWithOwner,
  unpackTileState,
  unpackTileTerrain,
} from "../src/core/game/OwnerIdCodec";

describe("versioned 16-bit ownership codec", () => {
  it("roundtrips every 16-bit owner without changing any legacy flag or terrain bit", () => {
    for (let owner = 0; owner <= 65535; owner++) {
      const flags = (owner & 15) << 12;
      const terrain = owner & 255;
      const state = stateWithOwner(flags, owner, true);
      const wire = packTileState(state, terrain);
      expect(ownerFromTileState(state)).toBe(owner);
      expect(state & 0xf000).toBe(flags);
      expect(checkedTileState(wire, true)).toBe(state);
      expect(unpackTileTerrain(wire)).toBe(terrain);
      expect(new Float32Array([state])[0]).toBe(state);
    }
  });
  it.each([4095, 4096, 16000, 65535])(
    "keeps every flag combination intact for owner %s",
    (owner) => {
      for (let flags = 0; flags < 16; flags++) {
        const state = stateWithOwner(flags << 12, owner, true);
        expect(unpackTileState(packTileState(state, 255))).toBe(state);
        expect(stateWithOwner(state, 0, true)).toBe(flags << 12);
      }
    },
  );
  it("preserves all 65536 legacy state words byte-for-byte on the wire", () => {
    for (let state = 0; state <= 65535; state++) {
      const terrain = state & 255;
      const wire = state | (terrain << 16);
      expect(packTileState(state, terrain)).toBe(wire);
      expect(checkedTileState(wire, false)).toBe(state);
    }
  });
  it("rejects overflow, malformed owners and extended data in legacy worlds", () => {
    for (const owner of [-1, 1.5, NaN, Infinity, 65536])
      expect(() => stateWithOwner(0, owner, true)).toThrow();
    expect(() => stateWithOwner(0, 4096, false)).toThrow();
    expect(() =>
      checkedTileState(
        packTileState(stateWithOwner(0, 16000, true), 128),
        false,
      ),
    ).toThrow();
    expect(() => checkedTileState(0xffffffff, true)).toThrow();
  });
  it("never leaks an extended owner through fog", () => {
    const state = stateWithOwner(0x6000, 16000, true);
    expect(ownerFromTileState(projectedTileState(state, true, true))).toBe(
      16000,
    );
    expect(projectedTileState(state, false, true)).toBe(0x1000);
    expect(projectedTileState(state, false, false)).toBe(0);
  });
  it("maps all owners into distinct bounded 2D texels with the same flat index", () => {
    for (const owner of [0, 255, 256, 4095, 4096, 16000, 65535]) {
      for (let row = 0; row < 32; row++) {
        const [x, y] = ownerTextureCoordinate(owner, row);
        expect(x).toBeLessThan(256);
        expect(y).toBeLessThan(8192);
        expect(y * 256 + x).toBe(row * 65536 + owner);
      }
    }
  });
});
