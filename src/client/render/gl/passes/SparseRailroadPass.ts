import type { GameMap } from "../../../../core/game/GameMap";
import type { RenderSettings } from "../RenderSettings";
import { createProgram } from "../utils/GlUtils";

// start.xy, end.xy, ownerID, isWater
const FLOATS_PER_INSTANCE = 6;

const VERTEX_SOURCE = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSegment;
layout(location = 2) in vec2 aOwnerWater;
uniform mat3 uCamera;
uniform float uZoom;
uniform float uThickness;
out float vSide;
flat out float vOwner;
flat out float vWater;
void main() {
  vec2 start = aSegment.xy;
  vec2 end = aSegment.zw;
  vec2 direction = normalize(end - start);
  vec2 normal = vec2(-direction.y, direction.x);
  // Preserve a tactile track width at close zoom and at least ~1.7 physical
  // pixels at ordinary play zoom. Geometry remains sparse and camera-local.
  float halfWidth = max(0.105 * uThickness, 0.85 / max(uZoom, 0.001));
  vec2 world = mix(start, end, aCorner.x) + normal * aCorner.y * halfWidth;
  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vSide = aCorner.y;
  vOwner = aOwnerWater.x;
  vWater = aOwnerWater.y;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uPalette;
uniform float uAlpha;
uniform float uFade;
uniform float uLocalPlayer;
uniform vec3 uLocalColor;
in float vSide;
flat in float vOwner;
flat in float vWater;
out vec4 outColor;
void main() {
  float edge = smoothstep(0.48, 0.96, abs(vSide));
  vec3 ownerColor = vOwner < 0.5
    ? vec3(0.80)
    : (abs(vOwner - uLocalPlayer) < 0.5
      ? uLocalColor
      : texelFetch(uPalette, ivec2(int(vOwner), 1), 0).rgb);
  vec3 base = vWater > 0.5 ? vec3(0.78, 0.27, 0.28) : ownerColor;
  // Bright inset with a dark forged edge reads clearly against every nation.
  vec3 color = mix(mix(base, vec3(1.0), 0.24), base * 0.24, edge);
  outColor = vec4(color, uAlpha * uFade);
}`;

export interface SparseRailSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  ownerID: number;
  isWater: boolean;
}

/** Pure geometry builder kept separate so the paged-renderer regression is testable. */
export function buildSparseRailroadSegments(
  rails: ReadonlyMap<number, number>,
  mapWidth: number,
  ownerAt: (ref: number) => number = () => 0,
  isWaterAt: (ref: number) => boolean = () => false,
): SparseRailSegment[] {
  const segments: SparseRailSegment[] = [];
  const add = (
    ref: number,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ) => {
    segments.push({
      startX,
      startY,
      endX,
      endY,
      ownerID: ownerAt(ref),
      isWater: isWaterAt(ref),
    });
  };
  for (const [ref, railType] of rails) {
    if (railType < 1 || railType > 6) continue;
    const x = ref % mapWidth;
    const y = (ref - x) / mapWidth;
    const cx = x + 0.5;
    const cy = y + 0.5;
    if (railType === 1) add(ref, cx, y, cx, y + 1);
    else if (railType === 2) add(ref, x, cy, x + 1, cy);
    else {
      const top = railType === 3 || railType === 4;
      const left = railType === 3 || railType === 5;
      add(ref, cx, cy, cx, top ? y : y + 1);
      add(ref, cx, cy, left ? x : x + 1, cy);
    }
  }
  return segments;
}

/**
 * Sparse instanced tracks for page-backed worlds. Unlike RailroadPass this
 * never allocates a mapWidth × mapHeight texture; cost follows rail length.
 */
export class SparseRailroadPass {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private instanceCount = 0;
  private localPlayerID = 0;
  private localColor: [number, number, number] = [0.86, 0.86, 0.82];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly map: GameMap,
    private readonly paletteTex: WebGLTexture,
    private readonly settings: RenderSettings,
  ) {
    this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
    this.vao = gl.createVertexArray()!;
    this.quadBuffer = gl.createBuffer()!;
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      // t along segment, signed side across its width.
      new Float32Array([0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = FLOATS_PER_INSTANCE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 0);
  }

  replace(rails: ReadonlyMap<number, number>): void {
    const segments = buildSparseRailroadSegments(
      rails,
      this.map.width(),
      (ref) => this.map.ownerID(ref),
      (ref) => this.map.isWater(ref),
    );
    const data = new Float32Array(segments.length * FLOATS_PER_INSTANCE);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const offset = i * FLOATS_PER_INSTANCE;
      data[offset] = segment.startX;
      data[offset + 1] = segment.startY;
      data[offset + 2] = segment.endX;
      data[offset + 3] = segment.endY;
      data[offset + 4] = segment.ownerID;
      data[offset + 5] = segment.isWater ? 1 : 0;
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);
    this.instanceCount = segments.length;
  }

  setLocalPlayer(id: number): void {
    this.localPlayerID = id;
  }

  setLocalColor(r: number, g: number, b: number): void {
    this.localColor = [r, g, b];
  }

  draw(camera: Float32Array, zoom: number, resolutionScale: number): void {
    if (this.instanceCount === 0 || !this.settings.passEnabled.railroad) return;
    const rs = this.settings.railroad;
    const effectiveZoom = zoom * resolutionScale;
    const fadeRange = Math.max(rs.railFadeRange, 0);
    const fadeStart = rs.railMinZoom - fadeRange;
    const fade =
      fadeRange === 0
        ? Number(effectiveZoom >= rs.railMinZoom)
        : Math.min(1, Math.max(0, (effectiveZoom - fadeStart) / fadeRange));
    if (fade <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.program, "uCamera"), false, camera);
    gl.uniform1f(gl.getUniformLocation(this.program, "uZoom"), zoom);
    gl.uniform1f(gl.getUniformLocation(this.program, "uThickness"), rs.railThickness);
    gl.uniform1f(gl.getUniformLocation(this.program, "uAlpha"), rs.railAlpha);
    gl.uniform1f(gl.getUniformLocation(this.program, "uFade"), fade);
    gl.uniform1f(gl.getUniformLocation(this.program, "uLocalPlayer"), this.localPlayerID);
    gl.uniform3f(
      gl.getUniformLocation(this.program, "uLocalColor"),
      this.localColor[0],
      this.localColor[1],
      this.localColor[2],
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
