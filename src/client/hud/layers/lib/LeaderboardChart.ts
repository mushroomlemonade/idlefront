export const HISTORY_WINDOWS = [
  { ticks: 600, label: "1 minute" },
  { ticks: 3000, label: "5 minutes" },
  { ticks: 9000, label: "15 minutes" },
  { ticks: 36000, label: "1 hour" },
  { ticks: 216000, label: "6 hours" },
  { ticks: 864000, label: "24 hours" },
  { ticks: 0, label: "all recorded" },
] as const;

export function historyRange(
  points: readonly Float64Array[],
  windowTicks: number,
): [number, number] {
  if (!points.length) return [0, 10];
  let first = Infinity,
    last = 0;
  for (const p of points) {
    first = Math.min(first, p[0]);
    last = Math.max(last, p[0]);
  }
  return [
    windowTicks > 0 ? Math.max(first, last - windowTicks) : first,
    Math.max(first + 10, last),
  ];
}

/** Retain the sample just before the window so a step crosses its left edge. */
export function windowPoints(
  points: readonly Float64Array[],
  first: number,
  last: number,
): Float64Array[] {
  const start = points.findIndex((p) => p[0] >= first);
  if (start < 0) return points.length ? [points[points.length - 1]] : [];
  return points.slice(Math.max(0, start - 1)).filter((p) => p[0] <= last);
}

export function valueRange(
  points: readonly Float64Array[],
  field: number,
  fit: boolean,
): [number, number] {
  if (!points.length) return [0, 1];
  let low = Infinity,
    high = 0;
  for (const p of points) {
    low = Math.min(low, p[field]);
    high = Math.max(high, p[field]);
  }
  const padding = Math.max(1, (high - low) * 0.08);
  return [fit ? Math.max(0, low - padding) : 0, Math.max(1, high + padding)];
}
