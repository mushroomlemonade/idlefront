import { expect, it } from "vitest";
import { FOG_CHARTED, FOG_VISIBLE, fogTileState } from "../../../src/core/network/FogTileState";

it("preserves visible game bits but clears hidden owner, defense and fallout", () => {
  expect(fogTileState(0x6123, true, true)).toBe(0x6123 | FOG_VISIBLE | FOG_CHARTED);
  expect(fogTileState(0x6123, false, true)).toBe(FOG_CHARTED);
  expect(fogTileState(0x6123, false, false)).toBe(0);
});
