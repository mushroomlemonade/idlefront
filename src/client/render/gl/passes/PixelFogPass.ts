import { createProgram, createTexture2D } from "../utils/GlUtils";

/** Board-space pixel fog. Visibility is supplied independently of animation. */
export class PixelFogPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private masks: WebGLTexture[];
  private locations: Record<string, WebGLUniformLocation | null> = {};
  private previous: Uint8Array;
  private current: Uint8Array;
  private changedAt = -1000;

  constructor(private gl: WebGL2RenderingContext, private width: number, private height: number) {
    this.program = createProgram(gl, `#version 300 es
      precision highp float;
      layout(location=0) in vec2 aPos;
      uniform mat3 uCamera;
      out vec2 vWorld;
      void main(){vWorld=aPos;gl_Position=vec4((uCamera*vec3(aPos,1.)).xy,0.,1.);}`, `#version 300 es
      precision highp float;
      in vec2 vWorld;
      uniform sampler2D uPrevious;
      uniform sampler2D uCurrent;
      uniform vec2 uSize;
      uniform float uTime;
      uniform float uReveal;
      out vec4 outColor;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      void main(){
        vec2 pixel=floor(vWorld/2.)*2.;
        vec2 uv=(floor(vWorld)+.5)/uSize;
        float clear=mix(texture(uPrevious,uv).r,texture(uCurrent,uv).r,uReveal);
        if(clear>.999) discard;
        // Slow advected noise, quantized into pixel-art shade bands. No blur,
        // particles, screen-space scrolling or per-frame mask uploads.
        float t=uTime*.7;
        float n=noise((pixel+vec2(t,-t*.35))/38.)*.7+noise((pixel+vec2(-t*.6,t*.25))/13.)*.3;
        float d=mod(floor(vWorld.x/2.)+floor(vWorld.y/2.),2.)*.045;
        float band=floor((n+d)*7.)/7.;
        vec3 shade=mix(vec3(.18,.23,.27),vec3(.52,.59,.61),band);
        // Retain an opaque unexplored interior. The visibility field alone
        // determines what is disclosed; animated noise never opens holes.
        float alpha=1.-clear;
        shade+=vec3(.07,.08,.075)*smoothstep(.02,.8,clear);
        outColor=vec4(shade,alpha);
      }`);
    this.vao=gl.createVertexArray()!;
    this.buffer=gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,width,0,0,height,0,height,width,0,width,height]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindVertexArray(null);
    this.current=new Uint8Array(width*height);
    this.previous=new Uint8Array(width*height);
    this.masks=[0,1].map(()=>createTexture2D(gl,{width,height,internalFormat:gl.R8,format:gl.RED,type:gl.UNSIGNED_BYTE,data:this.current,filter:gl.NEAREST}));
    for(const name of ["uCamera","uPrevious","uCurrent","uSize","uTime","uReveal"]) this.locations[name]=gl.getUniformLocation(this.program,name);
  }

  setVisibility(mask: Uint8Array, nowSeconds: number, immediate=false): void {
    if(mask.length!==this.current.length) throw new Error("Fog visibility dimensions mismatch");
    const blend=Math.max(0,Math.min(1,(nowSeconds-this.changedAt)/.65));
    for(let i=0;i<mask.length;i++) this.previous[i]=immediate?mask[i]:Math.round(this.previous[i]+(this.current[i]-this.previous[i])*blend);
    this.current.set(mask); this.changedAt=nowSeconds;
    const gl=this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    for(let i=0;i<2;i++){gl.bindTexture(gl.TEXTURE_2D,this.masks[i]);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,this.width,this.height,gl.RED,gl.UNSIGNED_BYTE,i===0?this.previous:this.current);}
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
  }

  draw(camera: Float32Array, seconds: number): void {
    const gl=this.gl;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniformMatrix3fv(this.locations.uCamera,false,camera);
    gl.uniform2f(this.locations.uSize,this.width,this.height);
    gl.uniform1f(this.locations.uTime,seconds);
    gl.uniform1f(this.locations.uReveal,Math.min(1,Math.max(0,(seconds-this.changedAt)/.65)));
    for(let i=0;i<2;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.masks[i]);}
    gl.uniform1i(this.locations.uPrevious,0);gl.uniform1i(this.locations.uCurrent,1);
    gl.drawArrays(gl.TRIANGLES,0,6); gl.bindVertexArray(null);
  }

  dispose(): void {const gl=this.gl;this.masks.forEach(t=>gl.deleteTexture(t));gl.deleteBuffer(this.buffer);gl.deleteVertexArray(this.vao);gl.deleteProgram(this.program);}
}
