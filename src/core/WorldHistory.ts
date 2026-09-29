/** Wire contract: server-owned, bounded historical data, independent of UI. */
export const WORLD_HISTORY_METRICS = [
  "tiles",
  "gold",
  "troops",
  "gdp",
  "maxtroops",
  "cities",
  "ports",
  "factories",
  "silos",
  "sams",
  "warships",
  "allies",
  "betrayals",
] as const;
export type HistoryMetric = (typeof WORLD_HISTORY_METRICS)[number];
export interface WorldHistoryResponse {
  tick: number;
  metrics: string;
  series: { id: string; points: Float64Array[] }[];
  restricted: boolean;
  events: {
    tick: number;
    text: string;
    kind: "nuke" | "capture";
    unitType?: import("./game/Game").UnitType;
  }[];
}

/** Preserve endpoints and local extrema while progressively thinning old data. */
export function compactWorldHistory(points: Float64Array[]): Float64Array[] {
  if (points.length < 256) return points;
  const result = [points[0]];
  for (let i = 1; i < 191; i += 2) {
    const left = points[i - 1],
      right = points[i + 2];
    const error = (p: Float64Array) => {
      const t = (p[0] - left[0]) / Math.max(1, right[0] - left[0]);
      let score = 0;
      for (let j = 1; j < p.length; j++)
        score = Math.max(
          score,
          Math.abs(p[j] - left[j] - (right[j] - left[j]) * t) /
            Math.max(1, Math.abs(left[j]), Math.abs(right[j])),
        );
      return score;
    };
    result.push(
      error(points[i]) >= error(points[i + 1]) ? points[i] : points[i + 1],
    );
  }
  return result.concat(points.slice(191));
}
