#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uTerrain;
uniform vec3 uOceanColor;
uniform vec3 uSandColor;
uniform vec3 uPlainsColor;
uniform vec3 uHighlandColor;
uniform vec3 uMountainColor;
uniform int uMineralEnabled;
uniform float uMineralStrength;
uniform float uMineralScale;
uniform float uMineralVeinStrength;
uniform float uMineralGrainStrength;
uniform sampler2D uBoardMaterial;

in vec2 vUV;
out vec4 fragColor;

vec3 mineralTerrain(vec3 base255, vec2 worldPos, bool isLand) {
  float scale = max(0.25, uMineralScale);
  vec2 uv = worldPos / (96.0 * scale);
  vec4 lookup = texture(uBoardMaterial, uv);
  float footprint = max(length(dFdx(worldPos)), length(dFdy(worldPos)));
  float detailFade = 1.0 - smoothstep(2.5 * scale, 15.0 * scale, footprint);
  vec2 normalXY = (lookup.rg * 2.0 - 1.0) * (0.58 * detailFade);
  vec3 normal = normalize(vec3(normalXY, 1.0));
  float light = 0.84 + 0.22 * max(0.0, dot(normal, normalize(vec3(-0.44, -0.58, 0.92))));
  float value = isLand ? lookup.b : lookup.a;
  float breakup = mix(0.91, 1.09, value);
  vec3 mineralBase = isLand
    ? mix(base255 * 0.72, sqrt(max(base255 / 255.0, vec3(0.0))) * 224.0, 0.28)
    : mix(base255 * 0.34, vec3(8.0, 22.0, 28.0), 0.58);
  mineralBase *= light * mix(1.0, breakup, detailFade);
  float crystal = smoothstep(0.84, 0.98, lookup.b) * detailFade;
  mineralBase += (isLand ? vec3(19.0) : vec3(5.0, 12.0, 15.0))
    * crystal * uMineralVeinStrength;
  return mix(base255, mineralBase, clamp(uMineralStrength, 0.0, 1.0));
}

bool landAt(ivec2 tc, ivec2 size) {
  tc = clamp(tc, ivec2(0), size - 1);
  return (texelFetch(uTerrain, tc, 0).r & 0x80u) != 0u;
}

void main() {
  ivec2 size = textureSize(uTerrain, 0);
  vec2 worldPos = vUV * vec2(size);
  ivec2 coord = clamp(ivec2(worldPos), ivec2(0), size - 1);
  uint terrain = texelFetch(uTerrain, coord, 0).r;
  bool isLand = (terrain & 0x80u) != 0u;
  bool isShoreline = (terrain & 0x40u) != 0u;
  float magnitude = float(terrain & 0x1fu);
  vec3 color;

  if (isLand && magnitude == 31.0) {
    color = vec3(60.0);
  } else if (isLand && isShoreline) {
    color = uSandColor;
  } else if (isLand && magnitude < 10.0) {
    color = uPlainsColor + vec3(0.0, -2.0 * magnitude, 0.0);
  } else if (isLand && magnitude < 20.0) {
    color = min(vec3(255.0), uHighlandColor + vec3(2.0 * (magnitude - 10.0)));
  } else if (isLand) {
    color = min(vec3(255.0), uMountainColor + vec3(floor(magnitude / 2.0)));
  } else if (isShoreline) {
    color = floor(0.7 * uOceanColor + vec3(76.5) + vec3(0.5));
  } else {
    color = max(vec3(0.0), uOceanColor - vec3(min(magnitude, 10.0)));
  }

  if (uMineralEnabled != 0) {
    color = mineralTerrain(color, worldPos, isLand);
    if (isShoreline) {
      vec2 edge = vec2(
        (landAt(coord + ivec2(1, 0), size) ? 1.0 : 0.0) -
          (landAt(coord - ivec2(1, 0), size) ? 1.0 : 0.0),
        (landAt(coord + ivec2(0, 1), size) ? 1.0 : 0.0) -
          (landAt(coord - ivec2(0, 1), size) ? 1.0 : 0.0)
      );
      if (dot(edge, edge) > 0.0) {
        float rim = dot(normalize(edge), normalize(vec2(-0.44, -0.58)));
        color *= isLand ? 0.91 + rim * 0.09 : 0.78 - rim * 0.05;
      }
    }
  }

  fragColor = vec4(color / 255.0, 1.0);
}
