// Read-only, streaming report. Usage: LOG GAME_ID [MIN_HOURS=8]
// It never starts/stops a match or treats a short smoke test as an overnight soak.
import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
export async function reportLongplayHealth(
  file: string,
  gameID: string,
  minimumHours = 8,
) {
  if (!Number.isFinite(minimumHours) || minimumHours <= 0)
    throw new Error("Invalid minimum hours");
  let first,
    last,
    samples = 0,
    regressions = 0,
    resets = 0,
    failures = 0;
  let minTPS = Infinity,
    maxP95 = 0,
    maxP99 = 0,
    peakRSS = 0,
    peakQueue = 0,
    largestGapMs = 0;
  const input = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of input) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.gameID !== gameID) continue;
    if (
      entry.message === "view delivery stopped" ||
      entry.message === "Authoritative simulation stopped"
    )
      failures++;
    const p = entry.rollingPerformance;
    if (entry.message !== "authoritative simulation" || !p || p.samples < 100)
      continue;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) continue;
    const sample = { at, tick: entry.tick, debt: p.clockDebtMs };
    first ??= sample;
    if (last) {
      if (sample.tick <= last.tick || sample.at < last.at) resets++;
      largestGapMs = Math.max(largestGapMs, sample.at - last.at);
    }
    last = sample;
    samples++;
    if (
      p.liveTPS < 9.5 ||
      p.tickP95Ms > 80 ||
      p.tickP99Ms > 100 ||
      p.debtChangeMs > 500
    )
      regressions++;
    minTPS = Math.min(minTPS, p.liveTPS ?? 0);
    maxP95 = Math.max(maxP95, p.tickP95Ms);
    maxP99 = Math.max(maxP99, p.tickP99Ms);
    peakRSS = Math.max(peakRSS, entry.processMemory?.rss ?? 0);
    for (const view of entry.viewDelivery ?? [])
      peakQueue = Math.max(peakQueue, view.peakQueuedBytes);
  }
  const hours = first && last ? (last.at - first.at) / 3600000 : 0;
  return {
    gameID,
    samples,
    measuredHours: hours,
    requiredHours: minimumHours,
    status:
      hours < minimumHours
        ? "insufficient duration"
        : regressions || resets || failures || largestGapMs > 120000
          ? "failed server soak gates"
          : "passed server soak gates; device reconnect validation still required",
    regressions,
    resets,
    deliveryOrSimulationFailures: failures,
    largestGapMs,
    minimumRollingTPS: Number.isFinite(minTPS) ? minTPS : null,
    maximumRollingP95Ms: maxP95,
    maximumRollingP99Ms: maxP99,
    clockDebtChangeMs: first && last ? last.debt - first.debt : null,
    peakSharedProcessRSSBytes: peakRSS,
    peakViewQueueBytes: peakQueue,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [file, gameID, hours = "8"] = process.argv.slice(2);
  if (!file || !gameID)
    throw new Error(
      "Usage: node --import tsx scripts/report-longplay-health.ts LOG GAME_ID [MIN_HOURS=8]",
    );
  console.log(
    JSON.stringify(
      await reportLongplayHealth(file, gameID, Number(hours)),
      null,
      2,
    ),
  );
}
