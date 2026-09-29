// Bounded generated workload, not a replay or an endurance certification.
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync } from "node:zlib";
import { GameStartInfoSchema } from "../src/core/Schemas";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../src/core/network/ViewProtocol";
import { SimulationHost } from "../src/server/simulation/SimulationHost";

const [database, maps, sourceGame] = process.argv.slice(2);
if (!database || !maps || !sourceGame)
  throw new Error("Usage: DATABASE MAPS SOURCE_GAME_ID");
const db = new DatabaseSync(database, { readOnly: true });
if (
  db
    .prepare("SELECT id FROM persistent_worlds WHERE phase='active' LIMIT 1")
    .get()
)
  throw new Error("Refusing to compete with a live playtest");
const row = db
  .prepare(
    "SELECT game_config_json FROM persistent_world_runtimes WHERE game_id=?",
  )
  .get(sourceGame);
db.close();
if (!row) throw new Error("Missing reference configuration");
const config = { ...JSON.parse(String(row.game_config_json)), bots: 3000 };
const start = GameStartInfoSchema.parse({
  gameID: "Bench3k1",
  lobbyCreatedAt: 0,
  config,
  players: [],
  simulationMode: "server-v1",
});
console.log(
  JSON.stringify({
    workload: "generated 3000-bot opening; no human inputs",
    map: config.gameMap,
    nationStrategy: config.nationStrategy,
  }),
);
const host = new SimulationHost(start, [], maps);
const durations: number[] = [];
try {
  await host.ready;
  for (let turnNumber = 0; turnNumber < 430; turnNumber++) {
    const result = await host.turn({ turnNumber, intents: [] });
    durations.push(result.duration);
    if (![0, 299, 399, 429].includes(turnNumber)) continue;
    const packet = decodeViewPacket(
      result.bytes.buffer.slice(
        result.bytes.byteOffset,
        result.bytes.byteOffset + result.bytes.byteLength,
      ) as ArrayBuffer,
    );
    const legacy = encodeViewPacket(packet, false),
      compact = encodeViewPacket(packet);
    const decodeMs = (bytes: Uint8Array<ArrayBuffer>) => {
      const before = performance.now();
      for (let i = 0; i < 10; i++) decodeViewPacket(bytes.buffer);
      return (performance.now() - before) / 10;
    };
    console.log(
      JSON.stringify({
        tick: result.tick,
        durationMs: result.duration,
        coreMs: result.coreDuration,
        encodingMs: result.encodingDuration,
        legacyBytes: legacy.length,
        compactBytes: compact.length,
        legacyDeflateBytes: deflateRawSync(legacy).length,
        compactDeflateBytes: deflateRawSync(compact).length,
        legacyDecodeMs: decodeMs(legacy),
        compactDecodeMs: decodeMs(compact),
        memory: result.workerMemory,
      }),
    );
  }
  const steady = durations.slice(300).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      ticks: durations.length,
      firstTickMs: durations[0],
      postSpawnMedianMs: steady[Math.floor(steady.length / 2)],
      postSpawnP95Ms: steady[Math.floor(steady.length * 0.95)],
      note: "Deflate estimate excludes WebSocket/TLS overhead; not measured device traffic or eight-hour soak.",
    }),
  );
} finally {
  host.stop();
}
