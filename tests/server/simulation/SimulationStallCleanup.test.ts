import { afterEach, expect, it, vi } from "vitest";
import { SimulationHost } from "../../../src/server/simulation/SimulationHost";
const mock = vi.hoisted(() => ({ worker: null as any }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
    constructor() {
      super();
      mock.worker = this;
    }
  }
  return { ...actual, Worker: FakeWorker, default: { ...actual, Worker: FakeWorker } };
});
afterEach(() => vi.useRealTimers());
it("terminates a stalled worker and rejects every outstanding request", async () => {
  vi.useFakeTimers();
  const host = new SimulationHost({} as never);
  mock.worker.emit("message", { ready: true });
  await host.ready;
  const turn = host.turn({ turnNumber: 0, intents: [] });
  const snapshot = host.snapshot();
  const settled = Promise.allSettled([turn, snapshot]);
  await vi.advanceTimersByTimeAsync(30_001);
  expect((await settled).map((r) => r.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(mock.worker.terminate).toHaveBeenCalledTimes(1);
  await expect(host.snapshot()).rejects.toThrow("Simulation stopped");
  host.stop();
  expect(mock.worker.terminate).toHaveBeenCalledTimes(1);
});
