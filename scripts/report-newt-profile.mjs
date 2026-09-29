// Read-only bounded report from saved telemetry and a V8 sample.
import fs from "node:fs";
import readline from "node:readline";
const [log, gameID, profilePath] = process.argv.slice(2);
if (!log || !gameID || !profilePath)
  throw Error("LOG GAME_ID PROFILE required");
const groups = new Map();
let first, last;
for await (const line of readline.createInterface({
  input: fs.createReadStream(log),
  crlfDelay: Infinity,
})) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.gameID !== gameID || e.message !== "authoritative simulation") continue;
  first ??= e;
  last = e;
  const ageHour = Math.floor(e.tick / 36000);
  const key = `${ageHour}h/${e.views > 0 ? "viewers" : "no-viewers"}`;
  const a = groups.get(key) ?? [];
  a.push(e);
  groups.set(key, a);
}
const quantile = (a, q) =>
  [...a].sort((a, b) => a - b)[
    Math.min(a.length - 1, Math.floor(a.length * q))
  ];
const hourly = [...groups].map(([period, rows]) => ({
  period,
  samples: rows.length,
  medianRollingTPS: quantile(
    rows.map((e) => e.rollingPerformance.liveTPS),
    0.5,
  ),
  medianRollingP50: quantile(
    rows.map((e) => e.rollingPerformance.tickP50Ms),
    0.5,
  ),
  medianRollingP95: quantile(
    rows.map((e) => e.rollingPerformance.tickP95Ms),
    0.5,
  ),
  maxRollingP99: Math.max(...rows.map((e) => e.rollingPerformance.tickP99Ms)),
  maxShips: Math.max(...rows.map((e) => e.entityCounts.warships)),
  maxTrade: Math.max(...rows.map((e) => e.entityCounts.tradeShips)),
}));
const p = JSON.parse(fs.readFileSync(profilePath, "utf8"));
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const parents = new Map();
for (const n of p.nodes)
  for (const child of n.children ?? []) parents.set(child, n.id);
const totals = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const us = p.timeDeltas[i] ?? 0;
  const stack = [];
  for (let id = p.samples[i]; id !== undefined; id = parents.get(id))
    stack.push(nodes.get(id).callFrame);
  const has = (s) => stack.some((f) => f.url.includes(s));
  // Exclusive buckets; routing is pulled out of callers, not double-counted.
  const category =
    us > 10000
      ? "unattributed sampling gaps"
      : stack[0]?.functionName === "(idle)"
        ? "idle / waiting (not spare CPU guarantee)"
        : stack[0]?.functionName === "(garbage collector)"
          ? "garbage collection"
          : has("/pathfinding/")
            ? "synchronous pathfinding"
            : has("NationStructureBehavior")
              ? "nation construction / upgrades"
              : has("PortExecution")
                ? "ports / trade selection"
                : has("NationExecution")
                  ? "other nation decisions"
                  : has("WarshipExecution") || has("MoveWarshipExecution")
                    ? "warships excluding routing"
                    : has("TrainStationExecution") || has("TrainExecution")
                      ? "rail / trains"
                      : has("ViewProtocol") || has("ViewSnapshot")
                        ? "view encoding / snapshots"
                        : "other simulation/runtime";
  totals.set(category, (totals.get(category) ?? 0) + us);
}
const total = [...totals.values()].reduce((a, b) => a + b, 0);
console.log(
  JSON.stringify(
    {
      gameID,
      firstTick: first?.tick,
      lastTick: last?.tick,
      wallHours:
        (Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 3600000,
      simulationHours: (last.tick - first.tick) / 36000,
      last,
      hourly,
      profileWallSeconds: (p.endTime - p.startTime) / 1e6,
      exclusiveProfile: [...totals]
        .sort((a, b) => b[1] - a[1])
        .map(([category, us]) => ({
          category,
          ms: Math.round(us / 1000),
          percent: +((us / total) * 100).toFixed(1),
        })),
    },
    null,
    2,
  ),
);
