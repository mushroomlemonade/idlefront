import { availableParallelism, freemem } from "node:os";
import { URL as NodeURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Config } from "../../core/configuration/Config";
import type { WildernessAttackInput } from "../../core/execution/planning/WildernessAttackState";
import type { WildernessAttackPlan } from "../../core/execution/planning/WildernessAttackPlanner";
import type { GameMap } from "../../core/game/GameMap";
import { SharedPlanningWorld } from "./SharedPlanningWorld";

/** Computation-only, opt-in R&D pool. No worker can mutate the authority.
 * One shared map copy, at most one 32-job message per worker in flight, ordered
 * results. Any worker/epoch failure disables the pool and returns no plans.
 * Callers MUST await execute before mutating the source, then validate plans
 * at each execution's original position. Not enabled by live SimulationWorker.
 */
export class ParallelWildernessPlanner {
  private workers: Worker[] = [];
  private world?: SharedPlanningWorld;
  private disabled = false;
  private nextID = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly configJSON: string;
  readonly metrics = { workers: 0, batches: 0, jobs: 0, errors: 0, totalMs: 0, sharedBytes: 0 };

  constructor(private readonly map: GameMap,
    private readonly config: ConstructorParameters<typeof Config>[0],
    private readonly count = Math.max(1, Math.min(4, availableParallelism() - 2))) {
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("Invalid planner worker count");
    this.configJSON = JSON.stringify(config);
  }

  async warm(): Promise<void> {
    if (this.disabled || this.world) return;
    try {
      const bytes = this.map.width() * this.map.height() * 3 + 4;
      if (bytes > Math.max(0, Math.min(freemem(), process.availableMemory()) - 1024 * 1024 * 1024))
        throw new Error("Insufficient shared planning memory headroom");
      this.world = new SharedPlanningWorld(this.map);
      this.metrics.sharedBytes = bytes;
      const ready: Promise<void>[] = [];
      for (let i = 0; i < this.count; i++) {
        const worker = new Worker(new NodeURL("./WildernessPlanner.worker.mjs", import.meta.url),
          { workerData: { world: this.world.data, config: this.config } });
        this.workers.push(worker);
        worker.on("error", () => { this.disabled = true; });
        ready.push(new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("Planner boot timeout")), 15000);
          const failed = () => finish(new Error("Planner failed to boot"));
          const received = (message: { ready?: boolean }) => {
            if (message.ready) finish();
          };
          const finish = (error?: Error) => {
            clearTimeout(timer); worker.off("error", failed); worker.off("exit", failed);
            worker.off("message", received);
            if (error) reject(error); else resolve();
          };
          worker.once("error", failed); worker.once("exit", failed); worker.on("message", received);
        }));
      }
      await Promise.all(ready);
      this.metrics.workers = this.workers.length;
    } catch {
      this.metrics.errors++;
      await this.close();
    }
  }

  execute(inputs: readonly WildernessAttackInput[]): Promise<(WildernessAttackPlan | null)[]> {
    const next = this.serial.then(() => this.batch(inputs));
    this.serial = next.catch(() => {});
    return next;
  }

  private async batch(inputs: readonly WildernessAttackInput[]): Promise<(WildernessAttackPlan | null)[]> {
    const missing = () => inputs.map(() => null);
    if (this.disabled || inputs.length === 0) return missing();
    if (inputs.length > 8192) return missing();
    await this.warm();
    if (this.disabled || !this.world) return missing();
    const tick = inputs[0].tick;
    if (inputs.some((input) => input.map !== this.map || input.tick !== tick ||
        Object.getPrototypeOf(input.config) !== Config.prototype ||
        input.config.attackLogic !== Config.prototype.attackLogic ||
        input.config.attackTilesPerTick !== Config.prototype.attackTilesPerTick ||
        input.config.falloutDefenseModifier !== Config.prototype.falloutDefenseModifier ||
        JSON.stringify(input.config.gameConfig()) !== this.configJSON)) return missing();
    const started = performance.now();
    const snapshot = this.world.beginRead();
    const world = this.world;
    const results: (WildernessAttackPlan | null)[] = inputs.map(() => null);
    let next = 0;
    let failed = false;
    try {
      await Promise.all(this.workers.map(async (worker) => {
        while (next < inputs.length && !this.disabled) {
          const start = next; next = Math.min(next + 32, inputs.length);
          const jobs = inputs.slice(start, next).map((input, offset) => ({
            index: start + offset, state: input.state, executionTick: input.executionTick }));
          const id = ++this.nextID;
          const response = await new Promise<{ index: number; plan: WildernessAttackPlan }[]>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error("Planner batch timeout")), 15000);
            const error = () => finish(new Error("Planner exited during batch"));
            const receive = (message: { id: number; error?: string; results?: { index: number; plan: WildernessAttackPlan }[] }) => {
              if (message.id !== id) return;
              if (message.error || !message.results || message.results.length !== jobs.length)
                finish(new Error(message.error ?? "Malformed planning results"));
              else finish(undefined, message.results);
            };
            const finish = (failure?: Error, value?: { index: number; plan: WildernessAttackPlan }[]) => {
              clearTimeout(timer); worker.off("message", receive); worker.off("error", error); worker.off("exit", error);
              if (failure) reject(failure); else resolve(value!);
            };
            worker.on("message", receive); worker.once("error", error); worker.once("exit", error);
            worker.postMessage({ id, snapshot, tick, jobs });
          });
          response.forEach((result, offset) => {
            if (result.index !== jobs[offset].index) throw new Error("Out-of-order planner results");
            results[result.index] = result.plan;
          });
        }
      }));
    } catch {
      failed = true;
      this.metrics.errors++;
      this.disabled = true;
      // Wait for every reader to stop before releasing the shared epoch.
      await Promise.all(this.workers.splice(0).map((worker) => worker.terminate()));
    } finally {
      if (!world.endRead(snapshot)) failed = true;
      this.metrics.totalMs += performance.now() - started;
    }
    if (failed || this.disabled) { await this.close(); return missing(); }
    this.metrics.batches++; this.metrics.jobs += inputs.length;
    return results;
  }

  async close(): Promise<void> {
    this.disabled = true;
    await Promise.all(this.workers.splice(0).map((worker) => worker.terminate()));
    this.world?.dispose();
  }
}
