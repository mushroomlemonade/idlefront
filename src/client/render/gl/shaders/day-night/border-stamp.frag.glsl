#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uTileTex;
uniform sampler2D uPalette;
uniform sampler2D uBorderTex;     // RG8 — border flags from BorderComputePass
uniform sampler2D uDefenseCoverageTex; // R8 — 1.0 = defended by same-owner post
uniform sampler2D uAffiliation;   // 256×2 RGBA8 — affiliation colors (row 0 = border)
uniform vec2 uMapSize;
uniform int uAltView;
uniform float uHighlightBrighten;
uniform float uDefenseCheckerDarken;
uniform float uEmbargoTintRatio;
uniform float uFriendlyTintRatio;
uniform vec3 uEmbargoTint;
uniform vec3 uFriendlyTint;
uniform int uMineralEnabled;
uniform float uMineralStrength;
uniform float uMineralScale;
uniform sampler2D uBoardMaterial;

in vec2 vWorldPos;
out vec4 fragColor;

uint ownerAt(ivec2 tc) {
  tc = clamp(tc, ivec2(0), ivec2(uMapSize) - ivec2(1));
  return texelFetch(uTileTex, tc, 0).r & uint(OWNER_MASK);
}

void main() {
  ivec2 tc = ivec2(floor(vWorldPos));
  if (tc.x < 0 || tc.y < 0 || tc.x >= int(uMapSize.x) || tc.y >= int(uMapSize.y)) discard;

  uint raw = texelFetch(uTileTex, tc, 0).r;
  uint owner = raw & uint(OWNER_MASK);

  // Read pre-computed border flags from BorderComputePass
  vec4 borderData = texelFetch(uBorderTex, tc, 0);
  float borderType = borderData.r;      // 0=interior, ~0.5=normal, ~1.0=highlight
  bool defense = texelFetch(uDefenseCoverageTex, tc, 0).r > 0.5; // same-owner defense post nearby
  float relation = borderData.g;        // 0.0=neutral, ~0.5=friendly, ~1.0=embargo

  bool isBorder = borderType > 0.25;
  bool isHighlightBorder = borderType > 0.75;

  // --- Border stamp: full-brightness border color ---
  if (isBorder && owner != 0u) {
    vec3 bc;
    if (uAltView != 0) {
      // Alt-view: pure affiliation color from palette row 0
      bc = texelFetch(uAffiliation, ivec2(int(owner), 0), 0).rgb;
    } else {
      float u = (float(owner) + 0.5) / float(PALETTE_SIZE);
      bc = texture(uPalette, vec2(u, 0.75)).rgb;
      if (isHighlightBorder) {
        bc = mix(bc, vec3(1.0), uHighlightBrighten);
      }
      // Relationship tint (applied BEFORE defense checkerboard, matching game)
      if (relation > 0.75) {
        bc = mix(bc, uEmbargoTint, uEmbargoTintRatio);
      } else if (relation > 0.25) {
        bc = mix(bc, uFriendlyTint, uFriendlyTintRatio);
      }
      // Defense bonus: checkerboard darken (applied AFTER tint, matching game)
      if (defense) {
        bool checker = ((tc.x + tc.y) & 1) == 1;
        if (checker) bc *= uDefenseCheckerDarken;
      }
      // Turn the existing one-tile tactical silhouette into a cut edge. Four
      // owner reads establish its direction; a fixed board light supplies the
      // bevel and contact shadow without another render pass.
      if (uMineralEnabled != 0) {
        vec2 edge = vec2(
          (ownerAt(tc + ivec2(-1, 0)) != owner ? 1.0 : 0.0) -
            (ownerAt(tc + ivec2(1, 0)) != owner ? 1.0 : 0.0),
          (ownerAt(tc + ivec2(0, -1)) != owner ? 1.0 : 0.0) -
            (ownerAt(tc + ivec2(0, 1)) != owner ? 1.0 : 0.0)
        );
        float bevel = dot(edge, edge) > 0.0
          ? dot(normalize(edge), normalize(vec2(-0.44, -0.58)))
          : 0.0;
        vec2 uv = (mix(vWorldPos, vWorldPos.yx, step(0.5, fract(float(owner) * 0.279))) /
          (96.0 * max(0.25, uMineralScale))) + vec2(fract(float(owner) * 0.1031));
        float crystal = texture(uBoardMaterial, uv).b;
        vec3 gemEdge = mix(bc * 0.62, sqrt(max(bc, vec3(0.0))), 0.42);
        gemEdge *= 0.88 + bevel * 0.16 + crystal * 0.09;
        bc = mix(bc, clamp(gemEdge, 0.0, 1.0), uMineralStrength * 0.62);
      }
    }
    fragColor = vec4(bc, 1.0);
    return;
  }

  discard;
}
