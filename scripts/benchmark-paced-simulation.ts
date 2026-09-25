// Real authoritative worker + two loopback WebSocket/ACK consumers. No changes
// to the dev database, active worlds, rules, or journal. Not a browser/GPU test.
import { once } from "node:events";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { GameStartInfoSchema, TurnSchema } from "../src/core/Schemas";
import { decodeViewPacket } from "../src/core/network/ViewProtocol";
import { SimulationHost } from "../src/server/simulation/SimulationHost";
import { ViewConnection } from "../src/server/simulation/ViewConnection";

const [input, output, fromArg = "1200", countArg = "1000"] =
  process.argv.slice(2);
if (!input || !output || fs.existsSync(output))
  throw new Error("Expected replay and new output path");
const replay = JSON.parse(fs.readFileSync(input, "utf8"));
const start = GameStartInfoSchema.parse(replay.start);
if (start.config.fogOfWar)
  throw new Error(
    "This harness currently measures the unfiltered world stream only",
  );
const turns = replay.turns.map((t: unknown, i: number) => {
  const turn = TurnSchema.parse(t);
  if (turn.turnNumber !== i) throw new Error("Journal gap");
  return turn;
});
const from = Number(fromArg),
  count = Number(countArg);
if (
  !Number.isSafeInteger(from) ||
  !Number.isSafeInteger(count) ||
  from < 0 ||
  count < 2 ||
  from + count > turns.length
)
  throw new Error("Bad range");
const db = new DatabaseSync(".data/persistent-worlds.sqlite", {
  readOnly: true,
});
const active = db.prepare(
  "SELECT id FROM persistent_worlds WHERE phase='active' LIMIT 1",
);
if (active.get()) {
  db.close();
  throw new Error("A user match is active; refusing competing benchmark");
}
const host = new SimulationHost(
  start,
  turns.slice(0, from),
  undefined,
  (progress) => {
    if (
      progress.completedTurns % 200 === 0 ||
      progress.completedTurns === progress.totalTurns
    )
      console.log(
        JSON.stringify({
          recovering: progress.completedTurns,
          total: progress.totalTurns,
        }),
      );
  },
);
const compressed = process.env.IDLE_BENCH_COMPRESSION !== "0";
// Match Worker.ts's production negotiation, not an uncompressed idealization.
const server = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  perMessageDeflate: compressed
    ? {
        threshold: 1024,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        concurrencyLimit: 4,
      }
    : false,
});
const views: ViewConnection[] = [],
  clients: WebSocket[] = [];
const snapshotsReady: Promise<void>[] = [];
const received: { tick: number; time: number; bytes: number }[][] = [[], []];
const wireStart: number[] = [];
let failure: Error | undefined;
const guard = setInterval(() => {
  if (active.get()) {
    failure = new Error("A user match started; stopping competing benchmark");
    host.stop(failure);
  }
}, 2000);
server.on("connection", (ws) => {
  let ready!: () => void;
  snapshotsReady.push(
    new Promise<void>((resolve) => {
      ready = resolve;
    }),
  );
  const view = new ViewConnection(
    ws,
    () => {
      failure = new Error("View connection failed");
    },
    () => ready(),
  );
  ws.on("message", (bytes) => view.acknowledge(Number(bytes.toString())));
  views.push(view);
});
const compute: number[] = [],
  core: number[] = [],
  navigation: number[] = [],
  encode: number[] = [];
const turnTimings: Array<{
  tick: number;
  scheduledAt: number;
  dispatchedAt: number;
  completedAt: number;
  enqueuedAt: number;
}> = [];
try {
  await once(server, "listening");
  await host.ready;
  const port = (server.address() as { port: number }).port;
  for (let index = 0; index < 2; index++) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(client);
    client.on("message", (data) => {
      const bytes = data as Buffer;
      const sequence = bytes.readUInt32BE(0);
      client.send(String(sequence));
      const payload = bytes.subarray(4);
      const packet = decodeViewPacket(
        payload.buffer.slice(
          payload.byteOffset,
          payload.byteOffset + payload.byteLength,
        ) as ArrayBuffer,
      );
      if (packet.kind === "update" && packet.update.tick > from)
        received[index].push({
          tick: packet.update.tick,
          time: performance.now(),
          bytes: bytes.byteLength,
        });
    });
    await once(client, "open");
  }
  const snapshot = await host.snapshot();
  for (const view of views) view.startSnapshot([...snapshot.packets]);
  await Promise.race([
    Promise.all(snapshotsReady),
    delay(30_000).then(() => {
      throw new Error("Snapshot timeout");
    }),
  ]);
  for (const client of clients)
    wireStart.push((client as any)._socket.bytesRead);
  let deadline = performance.now() + 100;
  for (let i = from; i < from + count; i++) {
    await delay(Math.max(0, deadline - performance.now()));
    const dispatchedAt = performance.now();
    const result = await host.turn(turns[i]);
    const completedAt = performance.now();
    compute.push(result.duration);
    core.push(result.coreDuration);
    navigation.push(result.navigationPreparationMs ?? 0);
    encode.push(result.encodingDuration);
    for (const view of views) view.enqueue(result.bytes, result.tick);
    turnTimings.push({
      tick: result.tick,
      scheduledAt: deadline,
      dispatchedAt,
      completedAt,
      enqueuedAt: performance.now(),
    });
    deadline += 100;
    if (failure) throw failure;
    if ((i + 1) % 100 === 0)
      console.log(
        JSON.stringify({
          tick: i + 1,
          duration: result.duration,
          core: result.coreDuration,
          navigation: result.navigationMetrics,
        }),
      );
  }
  const until = performance.now() + 10_000;
  while (received.some((r) => r.length < count) && performance.now() < until)
    await delay(10);
  if (
    received.some(
      (r) => r.length !== count || r.some((v, i) => v.tick !== from + i + 1),
    )
  )
    throw new Error("Missing/duplicated/out-of-order delivered tick");
  function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p95: sorted[Math.ceil(values.length * 0.95) - 1],
      p99: sorted[Math.ceil(values.length * 0.99) - 1],
      max: sorted.at(-1),
      over100: values.filter((v) => v > 100).length,
      over125: values.filter((v) => v > 125).length,
    };
  }
  const result = {
    gameID: start.gameID,
    from,
    count,
    compressed,
    storage: process.env.IDLE_SIMULATION_STORAGE ?? "auto",
    compute: stats(compute),
    core: stats(core),
    navigation: stats(navigation),
    encode: stats(encode),
    // ScheduledAt is the intended START of a tick, with its completion due
    // 100 ms later. Record raw clocks as well as lateness; never reset the
    // deadline after an overrun or hide accumulated lag behind average TPS.
    service: stats(turnTimings.map((t) => t.completedAt - t.dispatchedAt)),
    dispatchLateness: stats(
      turnTimings.map((t) => Math.max(0, t.dispatchedAt - t.scheduledAt)),
    ),
    completionLateness: stats(
      turnTimings.map((t) => Math.max(0, t.completedAt - t.scheduledAt - 100)),
    ),
    turnTimings,
    consumers: received.map((records, index) => ({
      delivered: records.length,
      tps:
        ((records.length - 1) * 1000) /
        (records.at(-1)!.time - records[0].time),
      intervals: stats(
        records.slice(1).map((v, i) => v.time - records[i].time),
      ),
      scheduledToReceipt: stats(
        records.map((v, i) => v.time - turnTimings[i].scheduledAt),
      ),
      receiptLateness: stats(
        records.map((v, i) =>
          Math.max(0, v.time - turnTimings[i].scheduledAt - 100),
        ),
      ),
      enqueueToReceipt: stats(
        records.map((v, i) => v.time - turnTimings[i].enqueuedAt),
      ),
      bytes: records.reduce((n, v) => n + v.bytes, 0),
      records,
      wireBytes: (clients[index] as any)._socket.bytesRead - wireStart[index],
    })),
  };
  fs.writeFileSync(output, JSON.stringify(result), { flag: "wx" });
  console.log(
    JSON.stringify({
      ...result,
      turnTimings: undefined,
      consumers: result.consumers.map(({ records, ...summary }) => summary),
    }),
  );
} finally {
  clearInterval(guard);
  db.close();
  for (const view of views) view.stop();
  for (const client of clients) client.terminate();
  for (const client of server.clients) client.terminate();
  server.close();
  host.stop();
}
