import { availableParallelism } from "node:os";
import { URL as NodeURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { Game } from "../../core/game/Game";
import { prepareWaterRoutes } from "../../core/pathfinding/PathFinder";
import { WaterRefinementTransformer } from "../../core/pathfinding/transformers/WaterRefinementTransformer";
import {
  enableWaterPreparation,
  takeWaterPreparation,
  type WaterRouteJob,
} from "../../core/pathfinding/WaterRoutePreparation";
import { shareWaterTerrain, type SharedWaterPages } from "./SharedWaterMap";

/** A computation-only pool. No worker can spend troops or change ownership.
 * Terrain is shared once. It is written only between awaited batches, and the
 * core cache separately validates its revision before accepting results. */
export class ParallelWaterRoutes {
  private workers: Worker[] = [];
  private shared: SharedWaterPages | undefined;
  private dirty = new Set<number>();
  private unsubscribe: () => void;
  private disabled = false;
  private sequence = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private local: WaterRefinementTransformer;
  readonly metrics = { batches: 0, jobs: 0, errors: 0, workers: 0, totalMs: 0 };
  constructor(
    private game: Game,
    private count = Math.max(1, Math.min(4, availableParallelism() - 2)),
  ) {
    enableWaterPreparation(game);
    this.local = new WaterRefinementTransformer(
      { findPath: () => null },
      game.map(),
    );
    this.unsubscribe = game.observeWaterConversions((tile) =>
      this.dirty.add(tile),
    );
  }
  async prepare(): Promise<void> {
    if (this.disabled) {
      takeWaterPreparation(this.game);
      return;
    }
    await prepareWaterRoutes(this.game, (jobs) => this.execute(jobs)).catch(
      () => {
        this.metrics.errors++;
        this.disabled = true;
        for (const worker of this.workers) void worker.terminate();
        this.workers = [];
        // Normal synchronous routing remains authoritative after any pool error.
      },
    );
  }
  async warm(): Promise<void> {
    if (this.count < 2 || this.disabled) return;
    try {
      await this.initialize();
    } catch {
      this.metrics.errors++;
      await this.close();
    }
  }
  execute(jobs: WaterRouteJob[]): Promise<(number[] | null)[]> {
    const result = this.serial.then(() => this.batch(jobs));
    this.serial = result.catch(() => {});
    return result;
  }
  private async initialize(): Promise<void> {
    this.shared ??= shareWaterTerrain(this.game.map());
    if (!this.workers.length) {
      const ready: Promise<void>[] = [];
      for (let i = 0; i < this.count; i++) {
        const worker = new Worker(
          new NodeURL("./WaterRoute.worker.mjs", import.meta.url),
          { workerData: this.shared },
        );
        this.workers.push(worker);
        ready.push(
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Route worker boot timeout")),
              10_000,
            );
            const finish = () => {
              clearTimeout(timer);
              worker.off("error", fail);
              worker.off("exit", fail);
            };
            const fail = () => {
              finish();
              reject(new Error("Route worker failed to boot"));
            };
            worker.once("error", fail);
            worker.once("exit", fail);
            worker.once("message", () => {
              finish();
              resolve();
            });
          }),
        );
        // Retain an error listener after startup; job-specific listeners reject.
        worker.on("error", () => {
          this.disabled = true;
        });
      }
      await Promise.all(ready);
      this.metrics.workers = this.workers.length;
    }
  }
  private async batch(jobs: WaterRouteJob[]): Promise<(number[] | null)[]> {
    if (this.disabled || this.count < 2 || jobs.length < 2)
      return jobs.map((q) => this.local.refine(q.route, q.from, q.to));
    const started = performance.now();
    await this.initialize();
    for (const tile of this.dirty) {
      const { pageIndex, offset } = this.game.map().tilePageLocation(tile);
      this.shared!.pages[pageIndex].terrain[offset] = this.game
        .map()
        .terrainByte(tile);
    }
    this.dirty.clear();
    const results: (number[] | null)[] = new Array(jobs.length);
    let next = 0;
    await Promise.all(
      this.workers.map(async (worker) => {
        while (next < jobs.length) {
          const index = next++,
            id = ++this.sequence;
          results[index] = await new Promise<number[] | null>(
            (resolve, reject) => {
              const timer = setTimeout(() => fail(), 10_000);
              const cleanup = () => {
                clearTimeout(timer);
                worker.off("message", receive);
                worker.off("error", fail);
                worker.off("exit", fail);
              };
              const fail = () => {
                cleanup();
                reject(new Error("Route worker failed"));
              };
              const receive = (message: {
                id: number;
                route: number[] | null;
                error?: string;
              }) => {
                if (message.id !== id) return;
                cleanup();
                if (message.error) reject(new Error(message.error));
                else resolve(message.route);
              };
              worker.on("message", receive);
              worker.once("error", fail);
              worker.once("exit", fail);
              worker.postMessage({ id, job: jobs[index] });
            },
          );
        }
      }),
    );
    this.metrics.batches++;
    this.metrics.jobs += jobs.length;
    this.metrics.totalMs += performance.now() - started;
    return results;
  }
  async close() {
    this.disabled = true;
    this.unsubscribe();
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}
