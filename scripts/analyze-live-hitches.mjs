import { readFileSync } from "node:fs";
const [profileFile, cadenceFile] = process.argv.slice(2);
const p = JSON.parse(readFileSync(profileFile, "utf8"));
const rows = JSON.parse(readFileSync(cadenceFile, "utf8")).rows;
const offset = p.workerClock.start.hrtimeUs / 1000 - p.workerClock.start.performanceMs;
const nodes = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const categories = new Map();
for (const n of p.nodes) {
  const stack = [];
  for (let id = n.id; id !== undefined; id = parent.get(id)) stack.push(nodes.get(id).callFrame);
  const has = (s) => stack.some(f => f.url.includes(s));
  const fn = (s) => stack.some(f => f.functionName === s);
  categories.set(n.id,
    n.callFrame.functionName === "(idle)" ? "idle" :
    n.callFrame.functionName === "(garbage collector)" ? "GC" :
    has("/pathfinding/") ? "routing" :
    fn("trackIncomingTransportsAndRetaliate") ? "nation transport scans" :
    has("ContinuousPressure") ? "continuous pressure" :
    fn("removeClusters") ? "border cluster cleanup" :
    has("NameBoxCalculator") ? "map name placement" :
    has("/network/") ? "view encoding" :
    has("AttackExecution") ? "attack expansion" : "other");
}
const ticks = new Map();
let time = p.startTime, index = 0;
for (let i = 0; i < p.samples.length; i++) {
  const delta = p.timeDeltas[i] ?? 0;
  time += delta;
  const now = time / 1000 - offset;
  while (index < rows.length && rows[index][1] < now) index++;
  if (index >= rows.length) break;
  const r = rows[index];
  if (r[1] - r[3] < p.startTime / 1000 - offset || r[1] > p.endTime / 1000 - offset) continue;
  if (now < r[1] - r[3]) continue;
  let t = ticks.get(r[0]);
  if (!t) ticks.set(r[0], t = { tick: r[0], duration: r[3], core: r[4], categories: {} });
  // A long sampling gap can be descheduling/profiler disturbance. Do not
  // attribute the whole gap to whichever function happened to be sampled.
  const category = delta > 10000 ? "unattributed sampling gap" : categories.get(p.samples[i]);
  t.categories[category] = (t.categories[category] ?? 0) + delta / 1000;
}
for (const [name, predicate] of [["over100ms", t => t.duration > 100], ["within100ms", t => t.duration <= 100]]) {
  const group = [...ticks.values()].filter(predicate), totals = {};
  for (const t of group) for (const [c, ms] of Object.entries(t.categories)) totals[c] = (totals[c] ?? 0) + ms;
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ group: name, ticks: group.length, categories: Object.entries(totals).sort((a,b) => b[1]-a[1]).map(([name, ms]) => ({ name, percent: +(ms/total*100).toFixed(1), msPerTick: +(ms/group.length).toFixed(1) })) }));
}
console.log(JSON.stringify({ slowest: [...ticks.values()].sort((a,b) => b.duration-a.duration).slice(0,8) }, null, 2));
