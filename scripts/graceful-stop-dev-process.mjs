// Windows does not deliver POSIX SIGTERM through process.kill. Invoke the
// application's registered shutdown handler through a loopback-only inspector.
// Use only after verifying the PID and stopping its external supervisor.
const pid = Number(process.argv[2]);
if (!Number.isSafeInteger(pid) || pid < 1)
  throw new Error("Expected verified PID");
process._debugProcess(pid);
let target;
for (let i = 0; i < 30; i++) {
  try {
    [target] = await (await fetch("http://127.0.0.1:9229/json/list")).json();
    if (target) break;
  } catch {
    /* Inspector may not be ready yet; retry within the bound below. */
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (!target) throw new Error("Inspector unavailable; no process stopped");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let serial = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data),
    p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error) p.reject(msg.error);
  else p.resolve(msg.result);
};
function evaluate(expression) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      timer: setTimeout(() => reject(new Error("Inspector timeout")), 10000),
    });
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }),
    );
  });
}
try {
  const check = await evaluate(
    '({pid:process.pid,argv:process.argv,handlers:process.listenerCount("SIGTERM"),gameEnv:process.env.GAME_ENV})',
  );
  const info = check.result?.value;
  if (
    info?.pid !== pid ||
    info.gameEnv !== "dev" ||
    info.handlers < 1 ||
    !info.argv.some((arg) => /src[\\/]server[\\/]Server\.ts$/.test(arg))
  )
    throw new Error(
      "Target is not the expected development backend with a shutdown handler",
    );
  await evaluate(
    'setTimeout(()=>{process.getBuiltinModule("inspector").close(); process.emit("SIGTERM");},250); void 0',
  );
  console.log(
    JSON.stringify({ pid, action: "registered SIGTERM handler scheduled" }),
  );
} finally {
  ws.close();
}
