/** Native world-space pixel clouds; no texture allocation or animated uploads. */
export const FOG_SHADER = `
float fogHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fogNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(fogHash(i),fogHash(i+vec2(1,0)),f.x),
             mix(fogHash(i+vec2(0,1)),fogHash(i+vec2(1,1)),f.x),f.y);
}
vec3 pixelCloud(vec2 world, float seconds) {
  vec2 pixel = floor(world / 2.0) * 2.0;
  float t = seconds * 0.7;
  float noise = fogNoise((pixel + vec2(t,-t*0.35))/38.0)*0.7 +
                fogNoise((pixel + vec2(-t*0.6,t*0.25))/13.0)*0.3;
  float dither = mod(floor(world.x/2.0)+floor(world.y/2.0),2.0)*0.035;
  float band = floor((noise+dither)*8.0)/8.0;
  return mix(vec3(0.23,0.28,0.31),vec3(0.44,0.51,0.54),band);
}
`;
