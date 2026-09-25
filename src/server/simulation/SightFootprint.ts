import type { SightSpan } from "./PlayerVisibility";

/** Exact tile-centre circle, compressed to at most one span per intersected row. */
export function circularSightFootprint(
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): SightSpan[] {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(width * height) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(radius) ||
    radius < 0
  )
    throw new Error("Invalid sight circle");
  const spans: SightSpan[] = [];
  const firstRow = Math.max(0, Math.ceil(y - radius));
  const lastRow = Math.min(height - 1, Math.floor(y + radius));
  for (let row = firstRow; row <= lastRow; row++) {
    const extent = Math.sqrt(Math.max(0, radius * radius - (row - y) ** 2));
    const left = Math.max(0, Math.ceil(x - extent));
    const right = Math.min(width - 1, Math.floor(x + extent));
    if (left <= right)
      spans.push([row * width + left, row * width + right + 1]);
  }
  return spans;
}
