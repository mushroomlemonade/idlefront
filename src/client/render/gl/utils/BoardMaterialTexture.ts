import { createTexture2D } from "./GlUtils";

/**
 * Compact, deterministic material lookup shared by the board shaders.
 *
 * RG stores a pre-baked tangent-space normal, B a pale mineral value and A a
 * darker resin value.  Keeping all four signals in one 128px texture makes a
 * board fragment one filtered lookup instead of several procedural noise
 * octaves.  The texture is generated once per WebGL context, costs 64 KiB
 * before mipmaps, and is independent of world dimensions.
 */
export const BOARD_MATERIAL_SIZE = 128;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function periodicNoise(
  x: number,
  y: number,
  cells: number,
  seed: number,
): number {
  const gx = (x / BOARD_MATERIAL_SIZE) * cells;
  const gy = (y / BOARD_MATERIAL_SIZE) * cells;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const ix = ((x0 % cells) + cells) % cells;
  const iy = ((y0 % cells) + cells) % cells;
  const tx = smooth(gx - x0);
  const ty = smooth(gy - y0);
  const a = hash2(ix, iy, seed);
  const b = hash2(x1, iy, seed);
  const c = hash2(ix, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function heightAt(x: number, y: number): number {
  const broad = periodicNoise(x, y, 4, 0x5417);
  const crystal = periodicNoise(x, y, 11, 0x8cab);
  const grain = periodicNoise(x, y, 29, 0x17e3);
  // Narrow ridges read as mineral fractures without introducing animated or
  // screen-aligned bands. They are baked here, so the fragment shader stays
  // constant-time and cheap.
  const fracture = Math.max(0, 1 - Math.abs(crystal - 0.5) * 13);
  return Math.min(
    1,
    Math.max(0, broad * 0.46 + crystal * 0.3 + grain * 0.12 + fracture * 0.12),
  );
}

export function createBoardMaterialData(): Uint8Array {
  const size = BOARD_MATERIAL_SIZE;
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) heights[y * size + x] = heightAt(x, y);
  }

  const data = new Uint8Array(size * size * 4);
  const sample = (x: number, y: number) =>
    heights[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = sample(x, y);
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * 1.8;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * 1.8;
      const invLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const offset = (y * size + x) * 4;
      data[offset] = Math.round((-dx * invLength * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((-dy * invLength * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((0.34 + h * 0.66) * 255);
      data[offset + 3] = Math.round((0.12 + (1 - h) * 0.62) * 255);
    }
  }
  return data;
}

export function createBoardMaterialTexture(
  gl: WebGL2RenderingContext,
): WebGLTexture {
  const texture = createTexture2D(gl, {
    width: BOARD_MATERIAL_SIZE,
    height: BOARD_MATERIAL_SIZE,
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    data: createBoardMaterialData(),
    filter: gl.LINEAR,
    wrap: gl.REPEAT,
  });
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  return texture;
}
