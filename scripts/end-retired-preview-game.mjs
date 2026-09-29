// Invoke the normal worker lifecycle for one already-retired preview world.
// Does not kill the backend, delete journals, or touch any other match.
import { DatabaseSync } from "node:sqlite";
const [gameID, expectedPID] = process.argv.slice(2);
if (!/^[A-Za-z0-9]{8}$/.test(gameID ?? "") || !/^\d+$/.test(expectedPID ?? ""))
  throw Error("GAME_ID WORKER_PID required");
const db = new DatabaseSync(".data/persistent-worlds.sqlite", {
  readOnly: true,
});
const world = db
  .prepare(
    "SELECT w.name,w.phase FROM persistent_worlds w JOIN persistent_world_runtimes r ON w.id=r.world_id WHERE r.game_id=?",
  )
  .get(gameID);
db.close();
if (world?.phase !== "finished") throw Error("World must already be finished");
const [target] = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let serial = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  clearTimeout(p.timer);
  if (m.error) p.reject(m.error);
  else p.resolve(m.result);
};
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => reject(Error("Inspector timeout")), 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const identity = await send("Runtime.evaluate", {
    expression: "({pid:process.pid,args:process.argv,cwd:process.cwd()})",
    returnByValue: true,
  });
  const info = identity.result?.value;
  if (
    info?.pid !== Number(expectedPID) ||
    !info.args.some((a) => a.endsWith("Server.ts")) ||
    !info.cwd.endsWith("checkout\\idlefront")
  )
    throw Error("Not the expected preview worker");
  const result = await send("Runtime.evaluate", {
    expression: `process.emit('message', {type:'endManagedGame',gameID:${JSON.stringify(gameID)}})`,
    returnByValue: true,
  });
  if (result.exceptionDetails || result.result?.value !== true)
    throw Error("Normal lifecycle dispatch failed");
  console.log(
    JSON.stringify({ gameID, world: world.name, normalEndDispatched: true }),
  );
} finally {
  await send("Runtime.evaluate", {
    expression:
      "setTimeout(()=>process.getBuiltinModule('inspector').close(),500);void 0",
  }).catch(() => {});
  ws.close();
}
