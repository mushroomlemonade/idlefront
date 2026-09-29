/** Reshape linear rows without changing their byte order or logical indexing. */
export function foldedTextureShape(
  width: number,
  height: number,
): { width: number; height: number } {
  let strips = 1;
  while (height / strips > 4096) strips *= 2;
  if (height % strips !== 0 || width * strips > 4096)
    throw new RangeError(`Cannot safely fold texture ${width}x${height}`);
  return { width: width * strips, height: height / strips };
}

/** GLSL named lookups keep their logical coordinates after row folding. */
export function foldNameTextureLookups(source: string): string {
  const specs = [
    ["uPlayerData", "foldedPlayerFetch", 9, "sampler2D", "vec4"],
    ["uCursorX", "foldedCursorFetch", 32, "sampler2D", "vec4"],
    ["uStrings", "foldedStringFetch", 32, "usampler2D", "uvec4"],
  ] as const;
  let helpers = "";
  for (const [uniform, name, width, sampler, result] of specs) {
    const pattern = new RegExp(`texelFetch\\(\\s*${uniform}\\s*,`, "g");
    if (!pattern.test(source)) continue;
    source = source.replace(pattern, `${name}(${uniform},`);
    helpers += `\nhighp ${result} ${name}(highp ${sampler} t, highp ivec2 p, highp int level) {
      highp int index = p.y * ${width} + p.x;
      highp int width = textureSize(t, level).x;
      return texelFetch(t, ivec2(index % width, index / width), level);
    }\n`;
  }
  // Insert before any user-defined functions and after the precision block.
  return helpers ? source.replace(/^uniform\s/m, helpers + "uniform ") : source;
}

export function foldOwnerTextureLookups(
  source: string,
  capacity: number,
): string {
  if (capacity <= 4096) return source;
  let changed = false;
  source = source.replace(
    /texelFetch\(\s*(uPalette|uEffect|uAffiliation)\s*,/g,
    (_, name) => {
      changed = true;
      return `ownerFetch(${name},`;
    },
  );
  source = source.replace(/texture\(\s*uPalette\s*,/g, () => {
    changed = true;
    return "ownerSample(uPalette,";
  });
  if (!changed) return source;
  const helpers = `
highp vec4 ownerFetch(highp sampler2D t, highp ivec2 p, highp int level) {
  highp int index = p.y * ${capacity} + p.x;
  highp int width = textureSize(t, level).x;
  return texelFetch(t, ivec2(index % width, index / width), level);
}
highp vec4 ownerSample(highp sampler2D t, highp vec2 uv) {
  return ownerFetch(t, ivec2(int(uv.x * float(${capacity})), int(uv.y * 2.0)), 0);
}
`;
  return source.replace(/^uniform\s/m, helpers + "uniform ");
}
