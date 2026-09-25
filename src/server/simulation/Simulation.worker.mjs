// tsx's registration must occur inside each Node worker, including production.
import { register } from "tsx/esm/api";
register();
await import("./SimulationWorker.ts");
