import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  chooseOverviewRasterSize,
  DETAIL_PAGE_SIZE,
  OverviewMapPass,
} from "../../../../src/client/render/gl/passes/OverviewMapPass";

describe("paged renderer sizing", () => {
  it("explicitly matches fog uniform precision across shader stages", () => {
    const source = readFileSync("src/client/render/gl/passes/OverviewMapPass.ts", "utf8");
    for (const stage of ["VERTEX_SOURCE", "FRAGMENT_SOURCE"]) {
      const shader = source.match(new RegExp("const " + stage + " = `([\\s\\S]*?)`;"))![1];
      expect(shader).toContain("precision highp int;");
      expect(shader).toContain("uniform highp int uFogEnabled;");
    }
  });
  it("keeps normal maps native resolution", () => {
    expect(chooseOverviewRasterSize(1024, 512)).toEqual({
      width: 1024,
      height: 512,
      scaleX: 1,
      scaleY: 1,
    });
  });

  it("bounds the overview independently of world dimensions", () => {
    const raster = chooseOverviewRasterSize(16432, 7792);
    expect(raster.width).toBeLessThanOrEqual(4096);
    expect(raster.height).toBeLessThanOrEqual(4096);
    expect(raster.width * raster.height).toBeLessThanOrEqual(8.1 * 1024 * 1024);
    expect(raster.scaleX).toBeGreaterThan(1);
    expect(raster.scaleY).toBeGreaterThan(1);
  });

  it("uses exact 256 square tiles for the detail atlas", () => {
    expect(DETAIL_PAGE_SIZE).toBe(256);
  });
  it("aligns every LOD to the same power-of-two world grid, including partial edge cells", () => {
    for (const [w, h] of [
      [21344, 10124],
      [12324, 5844],
      [65537, 32771],
    ]) {
      const raster = chooseOverviewRasterSize(w, h);
      expect(Number.isInteger(Math.log2(raster.scaleX))).toBe(true);
      expect(raster.scaleX).toBe(raster.scaleY);
      expect(raster.width * raster.scaleX).toBeGreaterThanOrEqual(w);
      expect((raster.width - 1) * raster.scaleX).toBeLessThan(w);
    }
  });
  it("hides stale detail pages at overview zoom and supplies an intermediate aligned level", () => {
    const pass = Object.create(OverviewMapPass.prototype);
    Object.assign(pass, {
      map: { width: () => 21344, height: () => 10124 },
      raster: chooseOverviewRasterSize(21344, 10124),
      detailCapacity: 96,
      detailStride: 1,
      detailEnabled: true,
      pageGridWidth: 84,
      pageGridHeight: 40,
      clock: 0,
      resident: new Map(),
      dirtyDetailPages: new Set(),
      pageTable: new Uint16Array(84 * 40),
      gl: { bindTexture: vi.fn(), texSubImage2D: vi.fn() },
      ensureResident: vi.fn(),
    });
    pass.updateCamera(5500, 2450, 0.01, 1200, 800);
    expect(pass.detailEnabled).toBe(false);
    expect(pass.ensureResident).not.toHaveBeenCalled();
    pass.updateCamera(5500, 2450, 0.4, 1200, 800);
    expect(pass.detailStride).toBe(2);
    expect(pass.detailEnabled).toBe(true);
    expect(pass.ensureResident.mock.calls.length).toBeLessThanOrEqual(96);
    expect(pass.gl.texSubImage2D).toHaveBeenCalledOnce();
  });
});
