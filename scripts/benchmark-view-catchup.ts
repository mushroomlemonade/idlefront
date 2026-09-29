// Bounded synthetic mature-state catch-up benchmark; no server/DB mutations.
// Includes real protocol encode/decode and queue compaction, not iPhone/GPU time.
import { performance } from "node:perf_hooks";
import type WebSocket from "ws";
import { type GameUpdates, UnitType } from "../src/core/game/Game";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../src/core/game/GameUpdates";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../src/core/network/ViewProtocol";
import { ViewConnection } from "../src/server/simulation/ViewConnection";
import { compactViewState } from "../src/server/simulation/ViewStateCompactor";
const empty = (): GameUpdates =>
  Object.fromEntries(
    Object.values(GameUpdateType)
      .filter((t) => typeof t === "number")
      .map((t) => [t, []]),
  ) as GameUpdates;
const durations: number[] = [];
let sent = 0,
  wireBytes = 0,
  lastTick = 0;
const ws = {
  readyState: 1,
  send: (b: Buffer) => {
    sent = b.readUInt32BE(0);
    wireBytes += b.length;
    const packet = decodeViewPacket(Uint8Array.from(b.subarray(4)).buffer);
    if (packet.kind === "update") lastTick = packet.update.tick;
  },
} as unknown as WebSocket;
const view = new ViewConnection(
  ws,
  (failure) => {
    throw new Error(JSON.stringify(failure));
  },
  undefined,
  (a, b) => {
    const at = performance.now();
    const merged = compactViewState(a, b);
    durations.push(performance.now() - at);
    return merged;
  },
);
const started = performance.now();
let inputBytes = 0;
for (let tick = 1; tick <= 120; tick++) {
  const updates = empty();
  updates[GameUpdateType.Unit] = Array.from({ length: 2000 }, (_, id) => ({
    type: GameUpdateType.Unit,
    unitType: UnitType.Warship,
    troops: 0,
    id,
    ownerID: (id % 100) + 1,
    pos: id * 100 + tick,
    lastPos: id * 100 + tick - 1,
    isActive: true,
    reachedTarget: false,
    targetable: true,
    markedForDeletion: false,
    health: 100,
    underConstruction: false,
    missileTimerQueue: [],
    level: 1,
    hasTrainStation: false,
  }));
  const update: GameUpdateViewData = {
    tick,
    updates,
    packedTileUpdates: new Uint32Array(),
    packedPlayerUpdates: new Float64Array(
      Array.from({ length: 2000 * 4 }, (_, n) => (n % 4 ? tick : n / 4 + 1)),
    ),
  };
  const bytes = encodeViewPacket({ kind: "update", update });
  inputBytes += bytes.length;
  view.enqueue(bytes, tick);
}
const queued = view.diagnostics();
while (view.diagnostics().queuedFrames) view.acknowledge(sent);
view.stop();
if (lastTick !== 120) throw new Error("Catch-up lost final state");
durations.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    fixture:
      "2000 moving warships + 2000 player stats; 120 ticks with stalled ACKs",
    inputBytes,
    wireBytes,
    elapsedMs: performance.now() - started,
    lastTick,
    ...queued,
    compactionMedianMs: durations[Math.floor(durations.length / 2)],
    compactionP95Ms: durations[Math.floor(durations.length * 0.95)],
  }),
);
