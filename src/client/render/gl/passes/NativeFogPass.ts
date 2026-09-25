import { createMapQuad, createProgram } from "../utils/GlUtils";
import { FOG_SHADER } from "./FogShader";

/** Dense-map equivalent of the paged terrain shader's fog branch. */
export class NativeFogPass {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly camera: WebGLUniformLocation;
  private readonly time: WebGLUniformLocation;
  constructor(
    private readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    private readonly tiles: WebGLTexture,
  ) {
    this.program = createProgram(
      gl,
      `#version 300 es
      precision highp float;
      layout(location=0) in vec2 aPos;
      uniform mat3 uCamera;
      out vec2 vWorld;
      void main(){
        vec2 corners[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(-1,1),vec2(1,-1),vec2(1,1));
        vec2 clip=corners[gl_VertexID];
        vWorld=(inverse(uCamera)*vec3(clip,1)).xy;
        gl_Position=vec4(clip,0,1);
      }
    `,
      `#version 300 es
      precision highp float;
      precision highp usampler2D;
      uniform highp usampler2D uTiles;
      uniform float uTime;
      in vec2 vWorld;
      out vec4 outColor;
      ${FOG_SHADER}
      void main(){
        if(any(lessThan(vWorld,vec2(0))) || any(greaterThanEqual(vWorld,vec2(textureSize(uTiles,0))))){
          outColor=vec4(pixelCloud(vWorld,uTime),1); return;
        }
        uint state=texelFetch(uTiles,ivec2(vWorld),0).r;
        if((state & 32768u)!=0u) discard;
        outColor=vec4(pixelCloud(vWorld,uTime),(state & 4096u)!=0u ? 0.85 : 1.0);
      }
    `,
    );
    this.vao = createMapQuad(gl, width, height);
    this.camera = gl.getUniformLocation(this.program, "uCamera")!;
    this.time = gl.getUniformLocation(this.program, "uTime")!;
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTiles"), 0);
  }
  draw(camera: Float32Array, seconds: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.camera, false, camera);
    gl.uniform1f(this.time, seconds);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tiles);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}
