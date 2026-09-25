import { parentPort, workerData } from "node:worker_threads";
import { Config } from "../../core/configuration/Config";
import { planWildernessAttackKernel } from "../../core/execution/planning/WildernessAttackKernel";
import type { WildernessAttackState } from "../../core/execution/planning/WildernessAttackState";
import { sharedPlanningReader, type PlanningEpoch } from "./SharedPlanningWorld";

const reader = sharedPlanningReader(workerData.world);
const config = new Config(workerData.config, null, false);
parentPort!.on("message", (message: {
  id: number; snapshot: PlanningEpoch; tick: number;
  jobs: { index: number; state: WildernessAttackState; executionTick: number }[];
}) => {
  try {
    if (message.jobs.length > 32) throw new Error("Oversized planning batch");
    reader.begin(message.snapshot);
    const results = message.jobs.map((job) => ({ index: job.index,
      plan: planWildernessAttackKernel({ state: job.state, map: reader.map, config,
        tick: message.tick, executionTick: job.executionTick }) }));
    if (!reader.valid()) throw new Error("Planning world changed during computation");
    const transfer: ArrayBuffer[] = [];
    for (const { plan } of results) if (plan.kind === "shadow-plan")
      transfer.push(plan.state.heap.priorities.buffer as ArrayBuffer,
        plan.state.heap.tiles.buffer as ArrayBuffer, plan.readTiles.buffer as ArrayBuffer);
    parentPort!.postMessage({ id: message.id, results }, transfer);
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: String(error) });
  }
});
parentPort!.postMessage({ ready: true });
