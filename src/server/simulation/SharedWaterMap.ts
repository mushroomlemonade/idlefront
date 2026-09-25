import type { GameMap } from "../../core/game/GameMap";
import type { WaterRefinementMap } from "../../core/pathfinding/transformers/WaterRefinementTransformer";

export interface SharedWaterPages {
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  columns: number;
  pages: { width: number; terrain: Uint8Array<SharedArrayBuffer> }[];
}
export function shareWaterTerrain(map: GameMap): SharedWaterPages {
  const pages = map.tilePages();
  return {
    width: map.width(),
    height: map.height(),
    pageWidth: pages[0].width,
    pageHeight: pages[0].height,
    columns: Math.max(...pages.map((p) => p.pageX)) + 1,
    pages: pages.map((p) => {
      const terrain = new Uint8Array(new SharedArrayBuffer(p.terrain.length));
      terrain.set(p.terrain);
      return { width: p.width, terrain };
    }),
  };
}
export function sharedWaterMap(data: SharedWaterPages): WaterRefinementMap {
  const { width: w, height: h } = data;
  return {
    width: () => w,
    height: () => h,
    x: (tile) => tile % w,
    y: (tile) => Math.floor(tile / w),
    ref: (x, y) => y * w + x,
    isWater: (tile) => {
      const x = tile % w,
        y = Math.floor(tile / w);
      const px = Math.floor(x / data.pageWidth),
        py = Math.floor(y / data.pageHeight);
      const page = data.pages[py * data.columns + px];
      return !(
        page.terrain[
          (y - py * data.pageHeight) * page.width + x - px * data.pageWidth
        ] & 128
      );
    },
    manhattanDist: (a, b) =>
      Math.abs((a % w) - (b % w)) +
      Math.abs(Math.floor(a / w) - Math.floor(b / w)),
    neighbors4: (tile, out) => {
      let count = 0;
      const x = tile % w;
      if (tile >= w) out[count++] = tile - w;
      if (tile < (h - 1) * w) out[count++] = tile + w;
      if (x) out[count++] = tile - 1;
      if (x < w - 1) out[count++] = tile + 1;
      return count;
    },
  };
}
