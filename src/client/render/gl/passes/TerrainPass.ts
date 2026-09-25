/**
 * TerrainPass — renders the terrain map as a textured quad.
 *
 * Samples the shared R8UI terrain-byte texture and applies terrain colours in
 * GLSL. This avoids a second map-sized texture and a 4-byte-per-tile CPU bake.
 */

import type { RenderSettings } from "../RenderSettings";
import terrainFragSrc from "../shaders/terrain/terrain.frag.glsl?raw";
import terrainVertSrc from "../shaders/terrain/terrain.vert.glsl?raw";
import {
  resolveTerrainColors,
  TerrainColorOverrides,
} from "../utils/ColorUtils";
import { createMapQuad, createProgram, shaderSrc } from "../utils/GlUtils";

// ---------------------------------------------------------------------------
// TerrainPass
// ---------------------------------------------------------------------------

export class TerrainPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uCamera: WebGLUniformLocation;
  private readonly colorUniforms: readonly WebGLUniformLocation[];
  private readonly material: RenderSettings["material"];

  constructor(
    private gl: WebGL2RenderingContext,
    private readonly tex: WebGLTexture,
    mapW: number,
    mapH: number,
    terrainColors?: TerrainColorOverrides,
    material?: RenderSettings["material"],
    private readonly boardMaterialTex?: WebGLTexture,
  ) {
    this.material = material ?? {
      enabled: false,
      strength: 0,
      scale: 1,
      veinStrength: 0,
      grainStrength: 0,
    };
    this.program = createProgram(
      gl,
      shaderSrc(terrainVertSrc, { MAP_W: mapW, MAP_H: mapH }),
      terrainFragSrc,
    );
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.colorUniforms = [
      gl.getUniformLocation(this.program, "uOceanColor")!,
      gl.getUniformLocation(this.program, "uSandColor")!,
      gl.getUniformLocation(this.program, "uPlainsColor")!,
      gl.getUniformLocation(this.program, "uHighlandColor")!,
      gl.getUniformLocation(this.program, "uMountainColor")!,
    ];
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTerrain"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uBoardMaterial"), 1);
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uMineralEnabled"),
      this.material.enabled ? 1 : 0,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralStrength"),
      this.material.strength,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralScale"),
      this.material.scale,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralVeinStrength"),
      this.material.veinStrength,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uMineralGrainStrength"),
      this.material.grainStrength,
    );
    this.setTerrainColors(terrainColors);

    this.vao = createMapQuad(gl, mapW, mapH);
  }

  /**
   * Replace the base terrain colours by changing five uniforms. No map-sized
   * CPU rebuild or GPU upload is required.
   */
  setTerrainColors(terrainColors?: TerrainColorOverrides): void {
    const gl = this.gl;
    const colors = resolveTerrainColors(terrainColors);
    gl.useProgram(this.program);
    const values = [
      colors.ocean,
      colors.sand,
      colors.plains,
      colors.highland,
      colors.mountain,
    ] as const;
    for (let i = 0; i < values.length; i++) {
      const color = values[i];
      gl.uniform3f(this.colorUniforms[i], color[0], color[1], color[2]);
    }
  }

  /** Render the terrain. Call with depth test disabled, no blending. */
  draw(cameraMatrix: Float32Array): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.boardMaterialTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.boardMaterialTex);
    }

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    // The renderer owns the shared terrain texture.
    // VAO + buffer leak is acceptable on dispose (context is being destroyed)
  }
}
