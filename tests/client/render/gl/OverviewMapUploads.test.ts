import { expect, it, vi } from "vitest";
import { OverviewMapPass } from "../../../../src/client/render/gl/passes/OverviewMapPass";

function fixture() {
  const pass = Object.create(OverviewMapPass.prototype);
  const gl = {
    bindTexture: vi.fn(),
    texSubImage2D: vi.fn(),
    texSubImage3D: vi.fn(),
    pixelStorei: vi.fn(),
  };
  const terrain = new Uint8Array(256 * 256);
  const tiles = new Uint16Array(256 * 256);
  Object.assign(pass, {
    gl,
    map: {
      width: () => 256,
      height: () => 256,
      isValidRef: (r: number) => r >= 0 && r < 65536,
      terrainByte: () => 128,
      tileState: () => 7,
    },
    raster: { width: 256, height: 256, scaleX: 1, scaleY: 1 },
    terrain,
    tiles,
    pendingCells: new Set(),
    dirtyDetailPages: new Set(),
    fullUploadPending: false,
    detailStride: 1,
    pageGridWidth: 1,
    clock: 0,
    resident: new Map([
      [
        0,
        {
          slot: 0,
          used: 0,
          terrain: new Uint8Array(65536),
          tiles: new Uint16Array(65536),
          minY: Infinity,
          maxY: -1,
        },
      ],
    ]),
  });
  return { pass, gl };
}

it("measures a dense territory update's GPU submission count", () => {
  const { pass, gl } = fixture();
  const refs = Array.from({ length: 20000 }, (_, i) => i);
  const start = performance.now();
  pass.applyChangedTiles(refs);
  pass.flush();
  process.stdout.write(
    JSON.stringify({
      tiles: refs.length,
      ms: performance.now() - start,
      overviewUploads: gl.texSubImage2D.mock.calls.length,
      detailUploads: gl.texSubImage3D.mock.calls.length,
    }) + "\n",
  );
  expect(gl.texSubImage2D).toHaveBeenCalledTimes(2);
  expect(gl.texSubImage3D).toHaveBeenCalledTimes(2);
  expect(pass.resident.get(0).tiles[19999]).toBe(7);
  expect(pass.resident.get(0).tiles[20000]).toBe(0);
  expect(gl.texSubImage3D.mock.calls[0].slice(2, 8)).toEqual([
    0, 0, 0, 256, 79, 1,
  ]);
  gl.texSubImage2D.mockClear();
  gl.texSubImage3D.mockClear();
  pass.applyChangedTiles(refs);
  pass.flush();
  expect(gl.texSubImage2D).not.toHaveBeenCalled();
  expect(gl.texSubImage3D).not.toHaveBeenCalled();
});

it("coalesces repeated updates to the final state before drawing", () => {
  const { pass, gl } = fixture();
  pass.applyChangedTiles([270]);
  pass.map.tileState = () => 9;
  pass.applyChangedTiles([270]);
  expect(gl.texSubImage3D).not.toHaveBeenCalled();
  pass.flush();
  expect(gl.texSubImage3D).toHaveBeenCalledTimes(2);
  expect(pass.resident.get(0).tiles[270]).toBe(9);
  expect(pass.tiles[270]).toBe(9);
});

it("does not upload data into an evicted page's reused GPU slot", () => {
  const { pass, gl } = fixture();
  pass.applyChangedTiles([270]);
  pass.resident.clear();
  pass.flush();
  expect(gl.texSubImage3D).not.toHaveBeenCalled();
  expect(pass.dirtyDetailPages.size).toBe(0);
});
