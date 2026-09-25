// Stop explicitly named retired worker threads, never active worlds. Journals
// are retained. With no arguments, uses the earlier September 10 retired pair.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".data/persistent-worlds.sqlite", {
  readOnly: true,
});
const allowed = new Set(
  process.argv.length > 2 ? process.argv.slice(2) : ["iFGQu9SP", "coHfCmuH"],
);
for (const id of allowed) {
  const row = db
    .prepare(
      "SELECT w.phase FROM persistent_worlds w JOIN persistent_world_runtimes r ON w.id=r.world_id WHERE r.game_id=?",
    )
    .get(id);
  if (row?.phase !== "finished")
    throw new Error(`Refusing to stop non-retired world ${id}`);
}
db.close();
const [target] = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let serial = 0;
const pending = new Map(),
  sessions = [];
function receive(message, session = "") {
  if (message.method === "NodeWorker.attachedToWorker")
    sessions.push(message.params.sessionId);
  if (message.method === "NodeWorker.receivedMessageFromWorker")
    receive(JSON.parse(message.params.message), message.params.sessionId);
  const p = pending.get(`${session}:${message.id}`);
  if (p) {
    pending.delete(`${session}:${message.id}`);
    clearTimeout(p.timer);
    if (message.error) p.reject(message.error);
    else p.resolve(message.result);
  }
}
ws.onmessage = (event) => receive(JSON.parse(event.data));
function send(method, params = {}, session = "") {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const key = `${session}:${id}`;
    pending.set(key, {
      resolve,
      reject,
      timer: setTimeout(() => {
        pending.delete(key);
        reject(new Error(`Timeout ${method}`));
      }, 10000),
    });
    const message = JSON.stringify({ id, method, params });
    ws.send(
      session
        ? JSON.stringify({
            id: ++serial,
            method: "NodeWorker.sendMessageToWorker",
            params: { sessionId: session, message },
          })
        : message,
    );
  });
}
try {
  await send("NodeWorker.enable", { waitForDebuggerOnStart: false });
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const session of sessions) {
    const info = await send(
      "Runtime.evaluate",
      {
        expression:
          'process.getBuiltinModule("worker_threads").workerData?.start?.gameID',
        returnByValue: true,
      },
      session,
    );
    const id = info.result?.value;
    console.log("Worker", id, allowed.has(id) ? "retiring" : "preserving");
    if (!allowed.has(id)) continue;
    // In a worker thread process.exit exits only that thread. Deferred so the
    // inspector can acknowledge; SimulationHost rejects its outstanding jobs.
    await send(
      "Runtime.evaluate",
      { expression: "setTimeout(()=>process.exit(0),100); void 0" },
      session,
    );
  }
} finally {
  await send("NodeWorker.disable").catch(() => {});
  await send("Runtime.evaluate", {
    expression:
      'setTimeout(()=>process.getBuiltinModule("inspector").close(),500); void 0',
  }).catch(() => {});
  ws.close();
}
