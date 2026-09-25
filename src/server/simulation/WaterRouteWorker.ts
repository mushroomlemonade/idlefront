import { parentPort, workerData } from "node:worker_threads";
import { WaterRefinementTransformer } from "../../core/pathfinding/transformers/WaterRefinementTransformer";
import { sharedWaterMap, type SharedWaterPages } from "./SharedWaterMap";

const refinement = new WaterRefinementTransformer(
  { findPath: () => null },
  sharedWaterMap(workerData as SharedWaterPages),
);
parentPort!.on("message", ({ id, job }) => {
  try {
    const route = refinement.refine(job.route, job.from, job.to);
    parentPort!.postMessage({ id, route });
  } catch (error) {
    parentPort!.postMessage({ id, error: String(error) });
  }
});
parentPort!.postMessage({ ready: true });
