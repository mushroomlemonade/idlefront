import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { reportLongplayHealth } from "../../scripts/report-longplay-health";
const fixture = vi.hoisted(() => ({ lines: "" }));
vi.mock("node:fs", () => ({
  default: { createReadStream: () => Readable.from([fixture.lines]) },
}));
function logs(hours: number, bad = false) {
  return Array.from({ length: Math.floor(hours * 360) + 1 }, (_, i) =>
    JSON.stringify({
      gameID: "test",
      message: "authoritative simulation",
      tick: i * 100,
      timestamp: new Date(i * 10000).toISOString(),
      rollingPerformance: {
        samples: 600,
        liveTPS: bad ? 4 : 10,
        tickP95Ms: bad ? 200 : 50,
        tickP99Ms: bad ? 300 : 60,
        clockDebtMs: bad ? i * 100 : 0,
        debtChangeMs: bad ? 1000 : 0,
      },
    }),
  ).join("\n");
}
it("never passes an overnight gate with a short synthetic test", async () => {
  fixture.lines = logs(0.1);
  expect(await reportLongplayHealth("unused", "test")).toMatchObject({
    status: "insufficient duration",
  });
  fixture.lines = logs(8);
  expect(await reportLongplayHealth("unused", "test")).toMatchObject({
    status:
      "passed server soak gates; device reconnect validation still required",
    regressions: 0,
  });
  fixture.lines = logs(8, true);
  expect(await reportLongplayHealth("unused", "test")).toMatchObject({
    status: "failed server soak gates",
    minimumRollingTPS: 4,
  });
});
