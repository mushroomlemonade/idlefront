import type { GameMap } from "../../../../core/game/GameMap";
import type { RenderSettings } from "../RenderSettings";
import { FOG_SHADER } from "./FogShader";
import { createBoardMaterialTexture } from "../utils/BoardMaterialTexture";
import {
  createMapQuad,
  createProgram,
  createTexture2D,
} from "../utils/GlUtils";

const OVERVIEW_TEXEL_BUDGET = 8 * 1024 * 1024;
const OVERVIEW_MAX_EDGE = 4096;
export const DETAIL_PAGE_SIZE = 256;
const DETAIL_PAGE_CAPACITY = 96;

const VERTEX_SOURCE = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aPos;
uniform mat3 uCamera;
uniform vec2 uWorldSize;
uniform highp int uFogEnabled;
out vec2 vWorldPos;
void main() {
  if (uFogEnabled != 0) {
    vec2 corners[6] = vec2[6](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(-1,1),vec2(1,-1),vec2(1,1));
    vec2 clip = corners[gl_VertexID];
    gl_Position = vec4(clip, 0, 1);
    vWorldPos = (inverse(uCamera) * vec3(clip, 1)).xy;
    return;
  }
  vec3 clip = uCamera * vec3(aPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vWorldPos = aPos;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
in vec2 vWorldPos;
uniform highp usampler2D uTerrain;
uniform highp usampler2D uTiles;
uniform highp usampler2DArray uDetailTerrain;
uniform highp usampler2DArray uDetailTiles;
uniform highp usampler2D uPageTable;
uniform sampler2D uPalette;
uniform ivec2 uRasterSize;
uniform ivec2 uPageGrid;
uniform int uOverviewStride;
uniform int uDetailStride;
uniform int uDetailEnabled;
uniform vec3 uOceanColor;
uniform vec3 uSandColor;
uniform vec3 uPlainsColor;
uniform vec3 uHighlandColor;
uniform vec3 uMountainColor;
uniform vec2 uWorldSize;
uniform uint uHighlightOwner;
uniform float uTerritoryAlpha;
uniform int uMineralEnabled;
uniform float uMineralStrength;
uniform float uMineralScale;
uniform float uMineralVeinStrength;
uniform float uMineralGrainStrength;
uniform sampler2D uBoardMaterial;
uniform highp int uFogEnabled;
uniform float uFogTime;
out vec4 outColor;

${FOG_SHADER}

vec3 mineralSurface(vec3 base, vec2 worldPos, float seed, bool water) {
  float scale = max(0.25, uMineralScale);
  float transpose = step(0.5, fract(seed * 0.75487766));
  vec2 oriented = mix(worldPos, worldPos.yx, transpose);
  vec2 flip = vec2(
    mix(-1.0, 1.0, step(0.5, fract(seed * 0.381966))),
    mix(-1.0, 1.0, step(0.5, fract(seed * 0.618034)))
  );
  vec2 uv = oriented * flip / (96.0 * scale) + vec2(
    fract(seed * 0.1031),
    fract(seed * 0.11369)
  );
  vec4 lookup = texture(uBoardMaterial, uv);
  float footprint = max(length(dFdx(worldPos)), length(dFdy(worldPos)));
  float detailFade = 1.0 - smoothstep(2.5 * scale, 15.0 * scale, footprint);
  vec2 normalXY = (lookup.rg * 2.0 - 1.0) * (0.64 * detailFade);
  vec3 normal = normalize(vec3(normalXY, 1.0));
  float light = 0.82 + 0.24 * max(0.0, dot(normal, normalize(vec3(-0.44, -0.58, 0.92))));
  float value = water ? lookup.a : lookup.b;
  vec3 material = water
    ? mix(base * 0.20, vec3(0.018, 0.052, 0.066), 0.76)
    : mix(base * 0.66, sqrt(max(base, vec3(0.0))) * 0.94, 0.36);
  material *= light * mix(0.91, 1.09, mix(0.5, value, detailFade));
  float crystal = smoothstep(0.84, 0.98, lookup.b) * detailFade;
  material += (water ? vec3(0.018, 0.044, 0.054) : sqrt(max(base, vec3(0.0))))
    * crystal * uMineralVeinStrength * 0.35;
  return mix(base, clamp(material, 0.0, 1.0), uMineralStrength);
}

vec3 terrainColor(uint t) {
  bool land = (t & 128u) != 0u;
  bool shore = (t & 64u) != 0u;
  float magnitude = float(t & 31u);
  // Same byte-to-colour contract as terrain.frag.glsl, including riverbanks
  // and all existing magnitude steps; no separate distant-map palette.
  vec3 color;
  if (land && magnitude == 31.0) color = vec3(60.0);
  else if (land && shore) color = uSandColor;
  else if (land && magnitude < 10.0) color = uPlainsColor + vec3(0.0, -2.0 * magnitude, 0.0);
  else if (land && magnitude < 20.0) color = min(vec3(255.0), uHighlandColor + vec3(2.0 * (magnitude - 10.0)));
  else if (land) color = min(vec3(255.0), uMountainColor + vec3(floor(magnitude / 2.0)));
  else if (shore) color = floor(0.7 * uOceanColor + vec3(77.0));
  else color = max(vec3(0.0), uOceanColor - vec3(min(magnitude, 10.0)));
  return color / 255.0;
}

ivec2 overviewPos(ivec2 world) {
  return clamp(world / uOverviewStride, ivec2(0), uRasterSize - ivec2(1));
}

uint detailLayer(ivec2 world) {
  if (uDetailEnabled == 0) return 0u;
  ivec2 page = world / (${DETAIL_PAGE_SIZE} * uDetailStride);
  if (any(lessThan(page, ivec2(0))) || any(greaterThanEqual(page, uPageGrid))) return 0u;
  return texelFetch(uPageTable, page, 0).r;
}

uint terrainAt(ivec2 world) {
  uint layer = detailLayer(world);
  if (layer != 0u) {
    ivec2 local = (world / uDetailStride) % ${DETAIL_PAGE_SIZE};
    return texelFetch(uDetailTerrain, ivec3(local, int(layer - 1u)), 0).r;
  }
  return texelFetch(uTerrain, overviewPos(world), 0).r;
}

uint tileAt(ivec2 world) {
  uint layer = detailLayer(world);
  if (layer != 0u) {
    ivec2 local = (world / uDetailStride) % ${DETAIL_PAGE_SIZE};
    return texelFetch(uDetailTiles, ivec3(local, int(layer - 1u)), 0).r;
  }
  return texelFetch(uTiles, overviewPos(world), 0).r;
}

uint ownerAt(ivec2 world) {
  world = clamp(world, ivec2(0), ivec2(uWorldSize) - ivec2(1));
  return tileAt(world) & 4095u;
}

bool landAt(ivec2 world) {
  world = clamp(world, ivec2(0), ivec2(uWorldSize) - ivec2(1));
  return (terrainAt(world) & 128u) != 0u;
}

void main() {
  if (uFogEnabled != 0 && (any(lessThan(vWorldPos, vec2(0))) || any(greaterThanEqual(vWorldPos, uWorldSize)))) {
    outColor = vec4(pixelCloud(vWorldPos, uFogTime), 1);
    return;
  }
  ivec2 world = clamp(ivec2(vWorldPos), ivec2(0), ivec2(uWorldSize) - ivec2(1));
  uint terrain = terrainAt(world);
  uint tile = tileAt(world);
  if (uFogEnabled != 0 && (tile & 32768u) == 0u) {
    vec3 cloud = pixelCloud(vWorldPos, uFogTime);
    // Charted geography remains muted; no stale nation coloration is used.
    if ((tile & 4096u) != 0u) cloud = mix(cloud, terrainColor(terrain) * 0.55, 0.30);
    outColor = vec4(cloud, 1.0);
    return;
  }
  uint owner = tile & 4095u;
  bool isLand = (terrain & 128u) != 0u;
  vec3 color = terrainColor(terrain);
  if (uMineralEnabled != 0) {
    color = mineralSurface(color, vWorldPos, 0.0, !isLand);
    bool shoreline = (terrain & 64u) != 0u;
    if (shoreline) {
      vec2 coast = vec2(
        (landAt(world + ivec2(1, 0)) ? 1.0 : 0.0) -
          (landAt(world - ivec2(1, 0)) ? 1.0 : 0.0),
        (landAt(world + ivec2(0, 1)) ? 1.0 : 0.0) -
          (landAt(world - ivec2(0, 1)) ? 1.0 : 0.0)
      );
      if (dot(coast, coast) > 0.0) {
        float coastLight = dot(normalize(coast), normalize(vec2(-0.44, -0.58)));
        color *= isLand ? 0.91 + coastLight * 0.09 : 0.78 - coastLight * 0.05;
      }
    }
  }
  if (owner != 0u) {
    vec3 territory = texelFetch(uPalette, ivec2(int(owner), 0), 0).rgb;
    if (owner == uHighlightOwner) territory = mix(territory, vec3(1.0), 0.22);
    if (uMineralEnabled != 0) {
      territory = mineralSurface(
        territory,
        vWorldPos,
        float(owner) * 0.37,
        false
      );
    }
    color = mix(color, territory, uTerritoryAlpha);
    bool rightEdge = ownerAt(world + ivec2(1, 0)) != owner;
    bool leftEdge = ownerAt(world + ivec2(-1, 0)) != owner;
    bool downEdge = ownerAt(world + ivec2(0, 1)) != owner;
    bool upEdge = ownerAt(world + ivec2(0, -1)) != owner;
    bool border = rightEdge || leftEdge || downEdge || upEdge;
    if (border) {
      if (uMineralEnabled != 0) {
        vec2 edge = vec2(
          (leftEdge ? 1.0 : 0.0) - (rightEdge ? 1.0 : 0.0),
          (upEdge ? 1.0 : 0.0) - (downEdge ? 1.0 : 0.0)
        );
        float bevel = dot(edge, edge) > 0.0
          ? dot(normalize(edge), normalize(vec2(-0.44, -0.58)))
          : 0.0;
        color *= 0.69 + bevel * 0.14;
        color += max(bevel, 0.0) * sqrt(max(territory, vec3(0.0))) * 0.10;
      } else {
        color *= 0.56;
      }
    }
  }
  if ((tile & 8192u) != 0u) color = mix(color, vec3(0.20, 0.17, 0.15), 0.72);
  outColor = vec4(color, 1.0);
}`;

export interface OverviewRasterSize {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

export function chooseOverviewRasterSize(
  worldWidth: number,
  worldHeight: number,
): OverviewRasterSize {
  const scaleForBudget = Math.sqrt(
    (worldWidth * worldHeight) / OVERVIEW_TEXEL_BUDGET,
  );
  const scaleForEdge = Math.max(
    worldWidth / OVERVIEW_MAX_EDGE,
    worldHeight / OVERVIEW_MAX_EDGE,
  );
  const scale =
    2 ** Math.ceil(Math.log2(Math.max(1, scaleForBudget, scaleForEdge)));
  const width = Math.max(1, Math.ceil(worldWidth / scale));
  const height = Math.max(1, Math.ceil(worldHeight / scale));
  return {
    width,
    height,
    scaleX: scale,
    scaleY: scale,
  };
}

/**
 * Fixed-budget whole-world LOD. Logical coordinates remain exact; only the
 * raster backing the distant overview is bounded. Camera-local exact pages
 * can therefore be overlaid later without changing inputs or simulation.
 */
export class OverviewMapPass {
  readonly raster: OverviewRasterSize;
  private readonly terrain: Uint8Array;
  private readonly tiles: Uint16Array;
  private readonly terrainTex: WebGLTexture;
  private readonly tileTex: WebGLTexture;
  private readonly detailTerrainTex: WebGLTexture;
  private readonly detailTileTex: WebGLTexture;
  private readonly pageTableTex: WebGLTexture;
  private readonly boardMaterialTex: WebGLTexture;
  private readonly pageTable: Uint16Array;
  private readonly pageGridWidth: number;
  private readonly pageGridHeight: number;
  private readonly detailCapacity: number;
  private readonly resident = new Map<
    number,
    {
      slot: number;
      used: number;
      terrain: Uint8Array;
      tiles: Uint16Array;
      minY: number;
      maxY: number;
    }
  >();
  private readonly dirtyDetailPages = new Set<number>();
  private clock = 0;
  private detailStride = 1;
  private detailEnabled = false;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uCamera: WebGLUniformLocation;
  private readonly uHighlightOwner: WebGLUniformLocation;
  private readonly uFogEnabled: WebGLUniformLocation;
  private readonly uFogTime: WebGLUniformLocation;
  private fogEnabled = false;
  private fogTime = 0;
  private highlightOwner = 0;
  private pendingCells = new Set<number>();
  private fullUploadPending = true;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly map: GameMap,
    private readonly paletteTex: WebGLTexture,
    settings: RenderSettings,
  ) {
    this.raster = chooseOverviewRasterSize(map.width(), map.height());
    this.terrain = new Uint8Array(this.raster.width * this.raster.height);
    this.tiles = new Uint16Array(this.raster.width * this.raster.height);
    this.rebuildCpuRaster();

    this.terrainTex = createTexture2D(gl, {
      width: this.raster.width,
      height: this.raster.height,
      internalFormat: gl.R8UI,
      format: gl.RED_INTEGER,
      type: gl.UNSIGNED_BYTE,
      data: this.terrain,
      filter: gl.NEAREST,
    });
    this.tileTex = createTexture2D(gl, {
      width: this.raster.width,
      height: this.raster.height,
      internalFormat: gl.R16UI,
      format: gl.RED_INTEGER,
      type: gl.UNSIGNED_SHORT,
      data: this.tiles,
      filter: gl.NEAREST,
    });
    this.pageGridWidth = Math.ceil(map.width() / DETAIL_PAGE_SIZE);
    this.pageGridHeight = Math.ceil(map.height() / DETAIL_PAGE_SIZE);
    this.pageTable = new Uint16Array(this.pageGridWidth * this.pageGridHeight);
    this.detailCapacity = Math.max(
      1,
      Math.min(
        DETAIL_PAGE_CAPACITY,
        Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)),
      ),
    );
    this.detailTerrainTex = this.createArrayTexture(
      gl.R8UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
    );
    this.detailTileTex = this.createArrayTexture(
      gl.R16UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
    );
    this.pageTableTex = createTexture2D(gl, {
      width: this.pageGridWidth,
      height: this.pageGridHeight,
      internalFormat: gl.R16UI,
      format: gl.RED_INTEGER,
      type: gl.UNSIGNED_SHORT,
      data: this.pageTable,
      filter: gl.NEAREST,
    });
    this.boardMaterialTex = createBoardMaterialTexture(gl);
    this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
    this.vao = createMapQuad(gl, map.width(), map.height());
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uFogEnabled = gl.getUniformLocation(this.program, "uFogEnabled")!;
    this.uFogTime = gl.getUniformLocation(this.program, "uFogTime")!;
    this.uHighlightOwner = gl.getUniformLocation(
      this.program,
      "uHighlightOwner",
    )!;
    gl.useProgram(this.program);
    for (const [name, hex] of Object.entries(settings.terrain)) {
      const value = Number.parseInt(hex.replace("#", ""), 16);
      const uniform = "u" + name[0].toUpperCase() + name.slice(1);
      gl.uniform3f(
        gl.getUniformLocation(this.program, uniform),
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255,
      );
    }
    gl.uniform1i(gl.getUniformLocation(this.program, "uTerrain"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTiles"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 2);
    gl.uniform1i(gl.getUniformLocation(this.program, "uDetailTerrain"), 3);
    gl.uniform1i(gl.getUniformLocation(this.program, "uDetailTiles"), 4);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPageTable"), 5);
    gl.uniform1i(gl.getUniformLocation(this.program, "uBoardMaterial"), 6);
    gl.uniform2f(
      gl.getUniformLocation(this.program, "uWorldSize"),
      map.width(),
      map.height(),
    );
    gl.uniform2i(
      gl.getUniformLocation(this.program, "uRasterSize"),
      this.raster.width,
      this.raster.height,
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uOverviewStride"),
      this.raster.scaleX,
    );
    gl.uniform2i(
      gl.getUniformLocation(this.program, "uPageGrid"),
      this.pageGridWidth,
      this.pageGridHeight,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uTerritoryAlpha"),
      settings.mapOverlay.territoryAlpha,
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uMineralEnabled"),
      settings.material.enabled ? 1 : 0,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralStrength"),
      settings.material.strength,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralScale"),
      settings.material.scale,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralVeinStrength"),
      settings.material.veinStrength,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralGrainStrength"),
      settings.material.grainStrength,
    );
  }

  rebuild(): void {
    this.rebuildCpuRaster();
    this.pendingCells.clear();
    this.fullUploadPending = true;
  }

  applyChangedTiles(refs: readonly number[]): void {
    const worldW = this.map.width();
    for (const ref of refs) {
      if (!this.map.isValidRef(ref)) continue;
      const x = ref % worldW;
      const y = (ref - x) / worldW;
      const rx = Math.min(
        this.raster.width - 1,
        Math.floor(x / this.raster.scaleX),
      );
      const ry = Math.min(
        this.raster.height - 1,
        Math.floor(y / this.raster.scaleY),
      );
      const index = ry * this.raster.width + rx;
      const oldTerrain = this.terrain[index];
      const oldTile = this.tiles[index];
      this.sampleCell(rx, ry, index);
      if (oldTerrain !== this.terrain[index] || oldTile !== this.tiles[index])
        this.pendingCells.add(index);
      this.uploadResidentTile(ref, x, y);
    }
  }

  /**
   * Keep exact pages for the visible camera footprint plus one-page prefetch.
   * At whole-world zoom the fixed overview remains active; once the footprint
   * fits the cache, native-resolution tiles replace it page by page.
   */
  updateCamera(
    centerX: number,
    centerY: number,
    zoom: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    if (zoom <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return;
    this.detailEnabled = false;
    const halfW = viewportWidth / (2 * zoom);
    const halfH = viewportHeight / (2 * zoom);
    // One globally aligned LOD across the viewport. Never leave islands of
    // previously resident full-resolution pages in a distant overview.
    let stride = 1;
    while (
      stride < this.raster.scaleX &&
      (Math.ceil((2 * halfW) / (DETAIL_PAGE_SIZE * stride)) + 4) *
        (Math.ceil((2 * halfH) / (DETAIL_PAGE_SIZE * stride)) + 4) >
        this.detailCapacity
    )
      stride *= 2;
    if (stride >= this.raster.scaleX && stride > 1) return;
    if (stride !== this.detailStride) {
      this.detailStride = stride;
      this.resident.clear();
      this.dirtyDetailPages.clear();
      this.pageTable.fill(0);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.pageTableTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.pageGridWidth,
        this.pageGridHeight,
        gl.RED_INTEGER,
        gl.UNSIGNED_SHORT,
        this.pageTable,
      );
    }
    const pageSpan = DETAIL_PAGE_SIZE * stride;
    const minPageX = Math.max(0, Math.floor((centerX - halfW) / pageSpan) - 1);
    const maxPageX = Math.min(
      Math.ceil(this.map.width() / pageSpan) - 1,
      Math.floor((centerX + halfW) / pageSpan) + 1,
    );
    const minPageY = Math.max(0, Math.floor((centerY - halfH) / pageSpan) - 1);
    const maxPageY = Math.min(
      Math.ceil(this.map.height() / pageSpan) - 1,
      Math.floor((centerY + halfH) / pageSpan) + 1,
    );
    const count = (maxPageX - minPageX + 1) * (maxPageY - minPageY + 1);
    if (count > this.detailCapacity) return;
    // Protect all visible cached pages before choosing eviction victims.
    for (let y = minPageY; y <= maxPageY; y++)
      for (let x = minPageX; x <= maxPageX; x++) {
        const page = this.resident.get(y * this.pageGridWidth + x);
        if (page) page.used = ++this.clock;
      }
    for (let pageY = minPageY; pageY <= maxPageY; pageY++) {
      for (let pageX = minPageX; pageX <= maxPageX; pageX++) {
        this.ensureResident(pageX, pageY);
      }
    }
    this.detailEnabled = true;
  }

  private createArrayTexture(
    internalFormat: number,
    format: number,
    type: number,
  ): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("Unable to allocate detail page atlas");
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      internalFormat,
      DETAIL_PAGE_SIZE,
      DETAIL_PAGE_SIZE,
      this.detailCapacity,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private ensureResident(pageX: number, pageY: number): void {
    const pageIndex = pageY * this.pageGridWidth + pageX;
    const existing = this.resident.get(pageIndex);
    if (existing) {
      existing.used = ++this.clock;
      return;
    }
    let slot = this.resident.size;
    if (slot >= this.detailCapacity) {
      let oldestPage = -1;
      let oldestUsed = Infinity;
      for (const [candidate, record] of this.resident) {
        if (record.used < oldestUsed) {
          oldestUsed = record.used;
          oldestPage = candidate;
          slot = record.slot;
        }
      }
      if (oldestPage >= 0) {
        this.resident.delete(oldestPage);
        this.dirtyDetailPages.delete(oldestPage);
        this.pageTable[oldestPage] = 0;
        this.uploadPageTableEntry(oldestPage);
      }
    }

    const terrain = new Uint8Array(DETAIL_PAGE_SIZE * DETAIL_PAGE_SIZE);
    const tiles = new Uint16Array(DETAIL_PAGE_SIZE * DETAIL_PAGE_SIZE);
    const stride = this.detailStride;
    const originX = pageX * DETAIL_PAGE_SIZE * stride;
    const originY = pageY * DETAIL_PAGE_SIZE * stride;
    const width = Math.min(
      DETAIL_PAGE_SIZE,
      Math.ceil((this.map.width() - originX) / stride),
    );
    const height = Math.min(
      DETAIL_PAGE_SIZE,
      Math.ceil((this.map.height() - originY) / stride),
    );
    for (let localY = 0; localY < height; localY++) {
      for (let localX = 0; localX < width; localX++) {
        const worldX = Math.min(
          this.map.width() - 1,
          originX + localX * stride + Math.floor(stride / 2),
        );
        const worldY = Math.min(
          this.map.height() - 1,
          originY + localY * stride + Math.floor(stride / 2),
        );
        const ref = worldY * this.map.width() + worldX;
        const target = localY * DETAIL_PAGE_SIZE + localX;
        terrain[target] = this.map.terrainByte(ref);
        tiles[target] = this.map.tileState(ref);
      }
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailTerrainTex);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      slot,
      DETAIL_PAGE_SIZE,
      DETAIL_PAGE_SIZE,
      1,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      terrain,
    );
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailTileTex);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      slot,
      DETAIL_PAGE_SIZE,
      DETAIL_PAGE_SIZE,
      1,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      tiles,
    );
    this.resident.set(pageIndex, {
      slot,
      used: ++this.clock,
      terrain,
      tiles,
      minY: Infinity,
      maxY: -1,
    });
    this.pageTable[pageIndex] = slot + 1;
    this.uploadPageTableEntry(pageIndex);
  }

  private uploadPageTableEntry(pageIndex: number): void {
    const x = pageIndex % this.pageGridWidth;
    const y = (pageIndex - x) / this.pageGridWidth;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.pageTableTex);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      x,
      y,
      1,
      1,
      this.gl.RED_INTEGER,
      this.gl.UNSIGNED_SHORT,
      this.pageTable.subarray(pageIndex, pageIndex + 1),
    );
  }

  private uploadResidentTile(ref: number, x: number, y: number): void {
    const stride = this.detailStride;
    const sampleX = Math.min(
      this.map.width() - 1,
      Math.floor(x / stride) * stride + Math.floor(stride / 2),
    );
    const sampleY = Math.min(
      this.map.height() - 1,
      Math.floor(y / stride) * stride + Math.floor(stride / 2),
    );
    if (sampleX !== x || sampleY !== y) return;
    x = Math.floor(x / stride);
    y = Math.floor(y / stride);
    const pageX = Math.floor(x / DETAIL_PAGE_SIZE);
    const pageY = Math.floor(y / DETAIL_PAGE_SIZE);
    const pageIndex = pageY * this.pageGridWidth + pageX;
    const record = this.resident.get(pageIndex);
    if (!record) return;
    const localX = x - pageX * DETAIL_PAGE_SIZE;
    const localY = y - pageY * DETAIL_PAGE_SIZE;
    const index = localY * DETAIL_PAGE_SIZE + localX;
    const terrain = this.map.terrainByte(ref),
      tile = this.map.tileState(ref);
    if (record.terrain[index] === terrain && record.tiles[index] === tile)
      return;
    record.terrain[index] = terrain;
    record.tiles[index] = tile;
    record.minY = Math.min(record.minY, localY);
    record.maxY = Math.max(record.maxY, localY);
    this.dirtyDetailPages.add(pageIndex);
  }

  applyTerrainDelta(refs: readonly number[]): void {
    this.applyChangedTiles(refs);
  }

  setHighlightOwner(owner: number): void {
    this.highlightOwner = owner;
  }

  private rebuildCpuRaster(): void {
    let index = 0;
    for (let y = 0; y < this.raster.height; y++) {
      for (let x = 0; x < this.raster.width; x++, index++) {
        this.sampleCell(x, y, index);
      }
    }
  }

  private sampleCell(rx: number, ry: number, index: number): void {
    const worldX = Math.min(
      this.map.width() - 1,
      Math.floor((rx + 0.5) * this.raster.scaleX),
    );
    const worldY = Math.min(
      this.map.height() - 1,
      Math.floor((ry + 0.5) * this.raster.scaleY),
    );
    const ref = worldY * this.map.width() + worldX;
    this.terrain[index] = this.map.terrainByte(ref);
    this.tiles[index] = this.map.tileState(ref);
  }

  private flush(): void {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // At most two transfers per dirty resident page, not per changed tile.
    // Persistent CPU mirrors make contiguous row spans safe to upload without
    // changing untouched cells or allocating thousands of one-element arrays.
    for (const pageIndex of this.dirtyDetailPages) {
      const record = this.resident.get(pageIndex);
      if (!record || record.maxY < record.minY) continue;
      const start = record.minY * DETAIL_PAGE_SIZE;
      const end = (record.maxY + 1) * DETAIL_PAGE_SIZE;
      const height = record.maxY - record.minY + 1;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailTerrainTex);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        record.minY,
        record.slot,
        DETAIL_PAGE_SIZE,
        height,
        1,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        record.terrain.subarray(start, end),
      );
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailTileTex);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        record.minY,
        record.slot,
        DETAIL_PAGE_SIZE,
        height,
        1,
        gl.RED_INTEGER,
        gl.UNSIGNED_SHORT,
        record.tiles.subarray(start, end),
      );
      record.minY = Infinity;
      record.maxY = -1;
    }
    this.dirtyDetailPages.clear();
    if (this.fullUploadPending) {
      gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.raster.width,
        this.raster.height,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        this.terrain,
      );
      gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.raster.width,
        this.raster.height,
        gl.RED_INTEGER,
        gl.UNSIGNED_SHORT,
        this.tiles,
      );
      this.fullUploadPending = false;
      this.pendingCells.clear();
      return;
    }
    if (this.pendingCells.size === 0) return;
    let firstRow = Infinity,
      lastRow = -1;
    for (const index of this.pendingCells) {
      const row = Math.floor(index / this.raster.width);
      firstRow = Math.min(firstRow, row);
      lastRow = Math.max(lastRow, row);
    }
    const start = firstRow * this.raster.width;
    const end = (lastRow + 1) * this.raster.width;
    const height = lastRow - firstRow + 1;
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      firstRow,
      this.raster.width,
      height,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      this.terrain.subarray(start, end),
    );
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      firstRow,
      this.raster.width,
      height,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      this.tiles.subarray(start, end),
    );
    this.pendingCells.clear();
  }

  setFogRendering(enabled: boolean, seconds: number): void {
    this.fogEnabled = enabled;
    this.fogTime = seconds;
  }

  draw(camera: Float32Array): void {
    this.flush();
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1i(this.uFogEnabled, this.fogEnabled ? 1 : 0);
    gl.uniform1f(this.uFogTime, this.fogTime);
    gl.uniformMatrix3fv(this.uCamera, false, camera);
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uDetailStride"),
      this.detailStride,
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uDetailEnabled"),
      this.detailEnabled ? 1 : 0,
    );
    gl.uniform1ui(this.uHighlightOwner, this.highlightOwner);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailTerrainTex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailTileTex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.pageTableTex);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.boardMaterialTex);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    this.gl.deleteTexture(this.terrainTex);
    this.gl.deleteTexture(this.tileTex);
    this.gl.deleteTexture(this.detailTerrainTex);
    this.gl.deleteTexture(this.detailTileTex);
    this.gl.deleteTexture(this.pageTableTex);
    this.gl.deleteTexture(this.boardMaterialTex);
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}
