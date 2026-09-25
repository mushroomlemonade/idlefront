import { describe, expect, it } from "vitest";
import { GameMapImpl } from "../../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../../src/core/game/PagedGameMap";
import { WaterRefinementTransformer } from "../../../../src/core/pathfinding/transformers/WaterRefinementTransformer";
import { ReferenceWaterRefinementTransformer } from "../../../util/referenceWaterRefinement";

describe.each([false, true])(
  "water repair exact route equivalence, paged=%s",
  (paged) => {
    it("preserves ties, multi-source order, null routes and reused scratch across changing terrain", () => {
      let seed = 183;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
      };
      const width = 81,
        height = 67,
        terrain = new Uint8Array(width * height).fill(32);
      for (let i = 0; i < terrain.length; i++)
        if (random() % 7 === 0) terrain[i] = 128;
      const map = paged
        ? PagedGameMap.fromRowMajor(width, height, 16, terrain, 0)
        : new GameMapImpl(width, height, terrain, 0);
      let path: number[] = [];
      const inner = { findPath: () => path };
      const reference = new ReferenceWaterRefinementTransformer(inner, map);
      const optimized = new WaterRefinementTransformer(inner, map);
      for (let trial = 0; trial < 160; trial++) {
        const start = random() % terrain.length,
          to = random() % terrain.length;
        const sources =
          trial % 3 === 0 ? [start, random() % terrain.length, start] : start;
        path = [start];
        // Deliberately coarse segments, bank crossings and repeat blocks.
        for (let i = 0; i < 7; i++) path.push(random() % terrain.length);
        path.push(to);
        if (trial % 5 === 0) map.setWater(random() % terrain.length);
        expect(optimized.findPath(sources, to)).toEqual(
          reference.findPath(sources, to),
        );
      }
    });
    it("grows heap/records and then safely reuses them for tiny searches", () => {
      const width = 256,
        height = 128,
        terrain = new Uint8Array(width * height).fill(32);
      for (let y = 0; y < height; y++) terrain[y * width + 128] = 128;
      const map = paged
        ? PagedGameMap.fromRowMajor(width, height, 32, terrain, height)
        : new GameMapImpl(width, height, terrain, height);
      let path = Array.from({ length: width }, (_, x) => 64 * width + x);
      const inner = { findPath: () => path };
      const reference = new ReferenceWaterRefinementTransformer(inner, map),
        optimized = new WaterRefinementTransformer(inner, map);
      for (let i = 0; i < 5; i++)
        expect(optimized.findPath(path[0], path[path.length - 1])).toEqual(
          reference.findPath(path[0], path[path.length - 1]),
        );
      path = [0, 2, 4];
      expect(optimized.findPath(0, 4)).toEqual(reference.findPath(0, 4));
      path = [];
      expect(optimized.findPath([], 4)).toBeNull();
    });
  },
);

it("preserves duplicate-source heap ordering beyond initial buffer capacity", () => {
  const map = new GameMapImpl(64, 64, new Uint8Array(4096).fill(32), 0);
  const starts = [...Array.from({length:3000}, (_,i)=>i), 1, 2, 1];
  const inner = { findPath: () => [0, 4095] };
  const baseline = new ReferenceWaterRefinementTransformer(inner,map);
  const optimized = new WaterRefinementTransformer(inner,map);
  expect(optimized.findPath(starts,4095)).toEqual(baseline.findPath(starts,4095));
});

it("keeps the same 200,000-expansion cutoff and recovers after terrain changes", () => {
  const width=512, last=width*width-1;
  const terrain=new Uint8Array(width*width).fill(32);
  terrain[last-1]=terrain[last-width]=128;
  const map=PagedGameMap.fromRowMajor(width,width,64,terrain,2);
  const path=Array.from({length:width*width},(_,i)=>i);
  const inner={findPath:()=>path};
  const baseline=new ReferenceWaterRefinementTransformer(inner,map);
  const optimized=new WaterRefinementTransformer(inner,map);
  expect(baseline.findPath(0,last)).toBeNull();
  expect(optimized.findPath(0,last)).toBeNull();
  map.setWater(last-1);
  const expected=baseline.findPath(0,last);
  expect(expected).not.toBeNull();
  expect(optimized.findPath(0,last)).toEqual(expected);
});
