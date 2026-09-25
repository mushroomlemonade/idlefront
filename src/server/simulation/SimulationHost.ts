import { fileURLToPath, URL as NodeURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { GameStartInfo, LiveStats, Turn } from "../../core/Schemas";
import type { WinUpdate } from "../../core/game/GameUpdates";
import type { ViewQuery } from "../../core/network/ViewProtocol";

export interface TickResult {
  bytes: Uint8Array;
  views?: { clientID: string; bytes: Uint8Array; packets?: Uint8Array[] }[];
  tick: number;
  duration: number;
  coreDuration: number;
  encodingDuration: number;
  navigationPreparationMs?: number;
  navigationMetrics?: {
    batches: number;
    jobs: number;
    errors: number;
    workers: number;
    totalMs: number;
  };
  tileDeltaCount: number;
  motionPlanBytes: number;
  unitUpdateCount: number;
  stats?: LiveStats;
  win?: WinUpdate;
}

export interface SimulationRecoveryProgress {
  completedTurns: number;
  totalTurns: number;
  elapsedMs: number;
}

// Replaying a durable, week-scale world is real simulation work rather than a
// normal worker boot. Keep a firm upper bound, but size it from the journal so
// a healthy large recovery is not killed by the old three-minute constant.
export function simulationInitializationTimeout(turnCount: number): number {
  const BASE_TIMEOUT_MS = 180_000;
  // Late, structure-dense 2,000-bot worlds can exceed 50 ms/turn even though
  // their opening turns are much cheaper. Journal-only recovery must not kill
  // a healthy deterministic replay based on an early-game average. Durable
  // checkpoints will eventually bound this work; until then size the deadline
  // for the measured late-game cost on the reference host.
  const RECOVERY_BUDGET_PER_TURN_MS = 75;
  const MAX_TIMEOUT_MS = 60 * 60_000;
  return Math.min(
    MAX_TIMEOUT_MS,
    Math.max(BASE_TIMEOUT_MS, turnCount * RECOVERY_BUDGET_PER_TURN_MS),
  );
}

export class SimulationHost {
  readonly ready: Promise<void>;
  private worker: Worker;
  private sequence = 0;
  private requests = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stopped = false;
  constructor(
    start: GameStartInfo,
    turns: Turn[] = [],
    mapsDir?: string,
    onRecoveryProgress?: (progress: SimulationRecoveryProgress) => void,
  ) {
    this.worker = new Worker(
      new NodeURL("./Simulation.worker.mjs", import.meta.url),
      {
        workerData: {
          start,
          turns,
          mapsDir:
            mapsDir ??
            fileURLToPath(
              new NodeURL("../../../resources/maps/", import.meta.url),
            ),
        },
      },
    );
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Server simulation initialization timed out"));
        this.stop();
      }, simulationInitializationTimeout(turns.length));
      this.worker.on("message", (result) => {
        if (result.recoveryProgress) {
          onRecoveryProgress?.(result.recoveryProgress);
          return;
        }
        if (result.ready) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        const request = this.requests.get(result.id);
        if (!request) return;
        this.requests.delete(result.id);
        clearTimeout(request.timer);
        if (result.error) request.reject(new Error(result.error));
        else request.resolve(result);
      });
      const fail = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
        for (const request of this.requests.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        this.requests.clear();
        this.stopped = true;
      };
      this.worker.on("error", fail);
      this.worker.on("exit", (code) =>
        fail(new Error(`Simulation worker exited (${code})`)),
      );
    });
  }
  private async request(command: object): Promise<any> {
    await this.ready;
    if (this.stopped) throw new Error("Simulation stopped");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The worker may still be executing the command. Continuing after a
        // timed-out turn would diverge from the durable turn journal, and a
        // wedged worker must not consume CPU indefinitely in the background.
        this.stop(new Error("Server simulation request timed out"));
      }, 30_000);
      this.requests.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...command, id });
    });
  }
  turn(turn: Turn): Promise<TickResult> {
    return this.request({ type: "turn", turn });
  }
  snapshot(
    viewerClientID?: string,
  ): Promise<{ tick: number; packets: Uint8Array[] }> {
    return this.request({ type: "snapshot", viewerClientID });
  }
  forgetViewer(viewerClientID: string): Promise<void> {
    return this.request({ type: "forget_viewer", viewerClientID });
  }
  query(
    query: ViewQuery,
    viewerClientID: string,
  ): Promise<{ bytes: Uint8Array }> {
    return this.request({ type: "query", query, viewerClientID });
  }
  stop(error = new Error("Simulation stopped")): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.requests.clear();
    void this.worker.terminate();
  }
}
