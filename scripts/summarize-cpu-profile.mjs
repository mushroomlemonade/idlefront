import { readFileSync } from "node:fs";

const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = process.argv[3]
  ? JSON.parse(readFileSync(process.argv[3], "utf8"))
  : undefined;
const phase = report?.phaseClocks?.find(
  (r) => r.turn === Number(process.argv[4]),
);
if (report && !phase)
  throw new Error("Requested turn has no aligned phase clock");
const offsetUs = report
  ? report.profileClock.hrtimeUs - report.profileClock.performanceMs * 1000
  : 0;
const rangeStart = phase ? phase.start * 1000 + offsetUs : -Infinity;
const rangeEnd = phase ? phase.end * 1000 + offsetUs : Infinity;
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes)
  for (const child of node.children ?? []) parents.set(child, node.id);
const self = new Map(),
  inclusive = new Map();
const key = (id) => {
  const f = nodes.get(id).callFrame;
  return `${f.functionName === "" ? "(anonymous)" : f.functionName} ${f.url}:${f.lineNumber + 1}`;
};
let totalUs = 0;
let sampleStart = profile.startTime;
for (let i = 0; i < profile.samples.length; i++) {
  const sampleEnd = sampleStart + (profile.timeDeltas[i] ?? 0);
  const duration = Math.max(
    0,
    Math.min(sampleEnd, rangeEnd) - Math.max(sampleStart, rangeStart),
  );
  sampleStart = sampleEnd;
  if (!duration) continue;
  totalUs += duration;
  const id = profile.samples[i],
    label = key(id);
  self.set(label, (self.get(label) ?? 0) + duration);
  // A recursive frame contributes once to its inclusive total per sample.
  const seen = new Set();
  for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) {
    const label = key(cursor);
    if (seen.has(label)) continue;
    seen.add(label);
    inclusive.set(label, (inclusive.get(label) ?? 0) + duration);
  }
}
const top = (counts) =>
  [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([frame, us]) => ({
      frame,
      ms: Math.round(us / 1000),
      percent: +((100 * us) / totalUs).toFixed(2),
    }));
console.log(
  JSON.stringify(
    {
      phase: phase
        ? {
            turn: phase.turn,
            navigationMs: phase.navigationEnd - phase.start,
            executionMs: phase.coreEnd - phase.navigationEnd,
            snapshotMs: phase.end - phase.coreEnd,
          }
        : undefined,
      sampledMs: totalUs / 1000,
      self: top(self),
      inclusive: top(inclusive),
    },
    null,
    2,
  ),
);
