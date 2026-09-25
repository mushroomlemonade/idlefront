import type { RenderSettings } from "../RenderSettings";
import {
  EFFECT_PALETTE_BLOCKS,
  getPaletteSize,
  MAX_TRAIL_COLORS,
} from "../utils/ColorUtils";
import { createProgram, shaderSrc } from "../utils/GlUtils";

// center.xy, packed trail value
const FLOATS_PER_INSTANCE = 3;

const VERTEX_SOURCE = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aTrail;
uniform mat3 uCamera;
uniform float uZoom;
uniform float uResolutionScale;
out vec2 vCorner;
out vec2 vWorldPos;
flat out float vValue;
void main() {
  // Expanded worlds use more logical tiles for the same geography. Widen the
  // trail by that ratio, while retaining a one-pixel floor at overview zoom.
  float halfWidth = max(0.56 * uResolutionScale, 0.72 / max(uZoom, 0.001));
  vec2 world = aTrail.xy + aCorner * halfWidth;
  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vCorner = aCorner;
  vWorldPos = world;
  vValue = aTrail.z;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uPalette;
uniform sampler2D uEffect;
uniform float uAlpha;
uniform float uTime;
uniform int uAltView;
in vec2 vCorner;
in vec2 vWorldPos;
flat in float vValue;
out vec4 outColor;
void main() {
  float radius = length(vCorner);
  if (radius > 1.0) discard;
  uint packed = uint(vValue + 0.5);
  uint owner = packed & 0xFFFu;
  if (owner == 0u) discard;
  uint isNuke = (packed >> 12) & 1u;
  int o = int(owner);
  int rowBase = isNuke == 1u ? MAX_TRAIL_COLORS : 0;
  int count = int(texelFetch(uEffect, ivec2(o, rowBase), 0).a + 0.5);
  vec3 color;
  if (uAltView != 0 || count <= 0) {
    color = texelFetch(uPalette, ivec2(o, uAltView != 0 ? 1 : 0), 0).rgb;
  } else if (count == 1) {
    color = texelFetch(uEffect, ivec2(o, rowBase), 0).rgb;
  } else {
    int style = int(texelFetch(uEffect, ivec2(o, rowBase + 1), 0).a + 0.5);
    if (style == 1) {
      float frequency = texelFetch(uEffect, ivec2(o, rowBase + 2), 0).a;
      float t = uTime * frequency;
      int i = int(t) % count;
      int j = (i + 1) % count;
      color = mix(
        texelFetch(uEffect, ivec2(o, rowBase + i), 0).rgb,
        texelFetch(uEffect, ivec2(o, rowBase + j), 0).rgb,
        fract(t)
      );
    } else if (style == 2) {
      color = texelFetch(uEffect, ivec2(o, rowBase), 0).rgb;
    } else {
      float colorSize = max(texelFetch(uEffect, ivec2(o, rowBase + 2), 0).a, 0.001);
      float speed = texelFetch(uEffect, ivec2(o, rowBase + 3), 0).a;
      float phase = fract((vWorldPos.x + vWorldPos.y - uTime * speed) / (colorSize * float(count)));
      float f = phase * float(count);
      int i = int(f) % count;
      int j = (i + 1) % count;
      color = mix(
        texelFetch(uEffect, ivec2(o, rowBase + i), 0).rgb,
        texelFetch(uEffect, ivec2(o, rowBase + j), 0).rgb,
        fract(f)
      );
    }
  }
  float feather = 1.0 - smoothstep(0.7, 1.0, radius);
  // A pale refracted core keeps trails legible against both ocean and land.
  color = mix(color, vec3(1.0), (1.0 - radius) * 0.12);
  outColor = vec4(color, uAlpha * feather);
}`;

/**
 * Sparse, incrementally updated trail renderer for page-backed maps. Its GPU
 * and CPU cost follows live trail length; it never allocates a world-sized
 * R16 texture, so close-zoom boat and missile trails survive Ultra maps.
 */
export class SparseTrailPass {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private capacity = 0;
  private count = 0;
  private data = new Float32Array(0);
  private readonly slotByRef = new Map<number, number>();
  private readonly refBySlot: number[] = [];
  private altView = false;
  private readonly startTime = performance.now();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly mapWidth: number,
    private readonly paletteTex: WebGLTexture,
    private readonly effectTex: WebGLTexture,
    private readonly settings: RenderSettings,
  ) {
    this.program = createProgram(
      gl,
      VERTEX_SOURCE,
      shaderSrc(FRAGMENT_SOURCE, {
        PALETTE_SIZE: getPaletteSize(),
        MAX_TRAIL_COLORS,
        EFFECT_PALETTE_BLOCKS,
      }),
    );
    this.vao = gl.createVertexArray()!;
    this.quadBuffer = gl.createBuffer()!;
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, FLOATS_PER_INSTANCE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uEffect"), 1);
  }

  replace(state: ReadonlyMap<number, number>): void {
    this.slotByRef.clear();
    this.refBySlot.length = 0;
    this.count = state.size;
    this.capacity = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, this.count))));
    this.data = new Float32Array(this.capacity * FLOATS_PER_INSTANCE);
    let slot = 0;
    for (const [ref, value] of state) {
      this.slotByRef.set(ref, slot);
      this.refBySlot[slot] = ref;
      this.write(slot++, ref, value);
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.data, this.gl.DYNAMIC_DRAW);
  }

  apply(state: ReadonlyMap<number, number>, dirtyRefs: readonly number[]): void {
    if (dirtyRefs.length === 0) return;
    let min = Infinity;
    let max = -1;
    let grew = false;
    for (const ref of dirtyRefs) {
      const value = state.get(ref) ?? 0;
      const oldSlot = this.slotByRef.get(ref);
      if (value !== 0 && oldSlot !== undefined) {
        this.write(oldSlot, ref, value);
        min = Math.min(min, oldSlot);
        max = Math.max(max, oldSlot);
      } else if (value !== 0) {
        if (this.count >= this.capacity) {
          this.grow();
          grew = true;
        }
        const slot = this.count++;
        this.slotByRef.set(ref, slot);
        this.refBySlot[slot] = ref;
        this.write(slot, ref, value);
        min = Math.min(min, slot);
        max = Math.max(max, slot);
      } else if (oldSlot !== undefined) {
        const lastSlot = --this.count;
        this.slotByRef.delete(ref);
        if (oldSlot !== lastSlot) {
          const movedRef = this.refBySlot[lastSlot]!;
          this.refBySlot[oldSlot] = movedRef;
          this.slotByRef.set(movedRef, oldSlot);
          const from = lastSlot * FLOATS_PER_INSTANCE;
          this.data.copyWithin(
            oldSlot * FLOATS_PER_INSTANCE,
            from,
            from + FLOATS_PER_INSTANCE,
          );
        }
        this.refBySlot.length = this.count;
        min = Math.min(min, oldSlot);
        max = Math.max(max, oldSlot);
      }
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    if (grew) {
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.data, this.gl.DYNAMIC_DRAW);
    } else if (max >= min) {
      const begin = min * FLOATS_PER_INSTANCE;
      const end = (max + 1) * FLOATS_PER_INSTANCE;
      this.gl.bufferSubData(
        this.gl.ARRAY_BUFFER,
        begin * 4,
        this.data.subarray(begin, end),
      );
    }
  }

  private grow(): void {
    this.capacity = Math.max(256, this.capacity * 2);
    const next = new Float32Array(this.capacity * FLOATS_PER_INSTANCE);
    next.set(this.data);
    this.data = next;
  }

  private write(slot: number, ref: number, value: number): void {
    const offset = slot * FLOATS_PER_INSTANCE;
    const x = ref % this.mapWidth;
    this.data[offset] = x + 0.5;
    this.data[offset + 1] = (ref - x) / this.mapWidth + 0.5;
    this.data[offset + 2] = value;
  }

  setAltView(active: boolean): void {
    this.altView = active;
  }

  draw(camera: Float32Array, zoom: number, resolutionScale: number): void {
    if (this.count === 0 || !this.settings.passEnabled.trail) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.program, "uCamera"), false, camera);
    gl.uniform1f(gl.getUniformLocation(this.program, "uZoom"), zoom);
    gl.uniform1f(gl.getUniformLocation(this.program, "uResolutionScale"), resolutionScale);
    gl.uniform1f(gl.getUniformLocation(this.program, "uAlpha"), this.settings.mapOverlay.trailAlpha);
    gl.uniform1f(gl.getUniformLocation(this.program, "uTime"), (performance.now() - this.startTime) / 1000);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAltView"), this.altView ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.effectTex);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
