import { createProgram } from "../utils/GlUtils";

const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aSegment;
layout(location=2) in vec2 aHeatSea;
uniform mat3 uCamera;
uniform float uZoom;
out float vSide;
flat out vec2 vHeatSea;
void main(){
 vec2 normal=normalize(vec2(-(aSegment.w-aSegment.y),aSegment.z-aSegment.x));
 float width=mix(.35,2.8,aHeatSea.x);
 // Trunks remain distinguishable at strategic zoom without rail textures.
 // Width is capped in screen pixels so close-up lanes cannot cover units.
 float minimum=mix(.5,aHeatSea.y>.5?1.4:1.7,aHeatSea.x);
 float halfWidth=clamp(width*uZoom,minimum,4.)/max(uZoom,.001);
 vec2 p=mix(aSegment.xy,aSegment.zw,aCorner.x)+normal*aCorner.y*halfWidth;
 gl_Position=vec4((uCamera*vec3(p,1.)).xy,0.,1.);
 vSide=aCorner.y;vHeatSea=aHeatSea;
}`;
const fragment = `#version 300 es
precision highp float;
in float vSide;
flat in vec2 vHeatSea;
out vec4 outColor;
void main(){
 float feather=1.-smoothstep(.25,1.,abs(vSide));
 vec3 color=vHeatSea.y>.5 ? mix(vec3(.24,.49,.62),vec3(.04,.25,.46),vHeatSea.x) : mix(vec3(.42,.41,.34),vec3(.78,.68,.43),vHeatSea.x);
 float alpha=mix(.07,vHeatSea.y>.5?.58:.78,vHeatSea.x);
 outColor=vec4(color,feather*alpha);
}`;
/** One bounded instanced draw, no fullscreen framebuffer or heatmap allocation. */
export class TradeCorridorPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quad: WebGLBuffer;
  private buffer: WebGLBuffer;
  private count = 0;
  private last?: Float32Array;
  private cameraLocation: WebGLUniformLocation | null;
  private zoomLocation: WebGLUniformLocation | null;
  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, vertex, fragment);
    this.cameraLocation = gl.getUniformLocation(this.program, "uCamera");
    this.zoomLocation = gl.getUniformLocation(this.program, "uZoom");
    this.vao = gl.createVertexArray()!;
    this.quad = gl.createBuffer()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }
  update(data: Float32Array): void {
    if (data === this.last) return;
    this.last = data;
    this.count = data.length / 6;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);
  }
  draw(camera: Float32Array, zoom: number): void {
    if (!this.count) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix3fv(this.cameraLocation, false, camera);
    gl.uniform1f(this.zoomLocation, zoom);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
  }
  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.buffer);
  }
}
