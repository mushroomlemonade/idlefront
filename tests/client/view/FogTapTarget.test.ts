import { expect, it } from "vitest";
import { resolveFogTapTarget } from "../../../src/client/view/FogTapTarget";

it("snaps nearby fog taps to visible land without reading hidden ownership", () => {
  const map = {
    x: (tile: number) => tile % 100,
    y: (tile: number) => Math.floor(tile / 100),
    ref: (x: number, y: number) => y * 100 + x,
    isValidCoord: (x: number, y: number) => x >= 0 && y >= 0 && x < 100 && y < 100,
    isTileVisible: (tile: number) => tile === 5050,
    isLand: () => true,
    ownerID: (tile: number) => {
      if (tile !== 5050) throw new Error("Read hidden owner");
      return 0;
    },
  };
  expect(resolveFogTapTarget(5050, map, 1)).toBe(5050);
  expect(resolveFogTapTarget(5056, map, 1)).toBe(5050);
  expect(resolveFogTapTarget(5060, map, 1)).toBeNull();
  expect(resolveFogTapTarget(5056, {...map, ownerID: () => 1}, 1)).toBeNull();
});
