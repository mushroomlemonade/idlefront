// Read-only V8 sampling of an already-running worker through a loopback inspector.
import { mkdir, writeFile } from "node:fs/promises";
const [expectedGame, secondsArg = "20"] = process.argv.slice(2);
const seconds = Math.min(45, Math.max(5, Number(secondsArg)));
if (!expectedGame || !Number.isFinite(seconds))
  throw new Error("Usage: GAME_ID [seconds]");
const [target] = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let serial = 0;
const pending = new Map();
const sessions = [];
function receive(message, session = "") {
  if (message.method === "NodeWorker.attachedToWorker")
    sessions.push(message.params.sessionId);
  if (message.method === "NodeWorker.receivedMessageFromWorker") {
    receive(JSON.parse(message.params.message), message.params.sessionId);
  }
  if (message.id) {
    const key = session + ":" + message.id;
    const p = pending.get(key);
    if (p) {
      pending.delete(key);
      clearTimeout(p.timer);
      if (message.error) p.reject(message.error);
      else p.resolve(message.result);
    }
  }
}
ws.onmessage = (event) => receive(JSON.parse(event.data));
function send(method, params = {}, session = "") {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const key = session + ":" + id;
    pending.set(key, {
      resolve,
      reject,
      timer: setTimeout(() => {
        pending.delete(key);
        reject(new Error("Timeout: " + method));
      }, 15000),
    });
    const message = JSON.stringify({ id, method, params });
    if (session)
      ws.send(
        JSON.stringify({
          id: ++serial,
          method: "NodeWorker.sendMessageToWorker",
          params: { sessionId: session, message },
        }),
      );
    else ws.send(message);
  });
}
let profiling;
try {
  await send("NodeWorker.enable", { waitForDebuggerOnStart: false });
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const session of expectedGame.startsWith("parent-") ? [""] : sessions) {
    const info = await send(
      "Runtime.evaluate",
      {
        expression: expectedGame.startsWith("parent-")
          ? '({gameID:"parent-"+process.pid})'
          : '(()=>{const m=process.getBuiltinModule("worker_threads");return {gameID:m.workerData?.start?.gameID,keys:Object.keys(m.workerData?.start||{})};})()',
        returnByValue: true,
      },
      session,
    ).catch((error) => ({ diagnosticError: error }));
    console.log("Worker identity:", JSON.stringify(info.result?.value ?? info));
    if (info.result?.value?.gameID !== expectedGame) continue;
    await send("Profiler.enable", {}, session);
    await send("Profiler.setSamplingInterval", { interval: 1000 }, session);
    await send("Profiler.start", {}, session);
    profiling = session;
    const startedClock = await send(
      "Runtime.evaluate",
      {
        expression:
          "({performanceMs:performance.now(),hrtimeUs:Number(process.hrtime.bigint()/1000n)})",
        returnByValue: true,
      },
      session,
    );
    console.log(`Sampling ${expectedGame} for ${seconds}s; no debugger pause.`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const { profile } = await send("Profiler.stop", {}, session);
    const endedClock = await send(
      "Runtime.evaluate",
      {
        expression:
          "({performanceMs:performance.now(),hrtimeUs:Number(process.hrtime.bigint()/1000n)})",
        returnByValue: true,
      },
      session,
    );
    profile.workerClock = {
      start: startedClock.result?.value,
      end: endedClock.result?.value,
    };
    profiling = undefined;
    await send("Profiler.disable", {}, session);
    await mkdir(".dev-logs/profiles", { recursive: true });
    const filename = `.dev-logs/profiles/${expectedGame}-${Date.now()}.cpuprofile`;
    await writeFile(filename, JSON.stringify(profile));
    console.log("Saved:", filename);
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes)
      for (const child of n.children ?? []) parent.set(child, n.id);
    const self = new Map(),
      inclusive = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i],
        delta = profile.timeDeltas[i] ?? 0;
      self.set(id, (self.get(id) ?? 0) + delta);
      for (let p = id; p !== undefined; p = parent.get(p))
        inclusive.set(p, (inclusive.get(p) ?? 0) + delta);
    }
    const summarize = (map) => {
      const grouped = new Map();
      for (const [id, us] of map) {
        const f = nodes.get(id).callFrame;
        const key = `${f.functionName === "" ? "(anonymous)" : f.functionName} ${f.url}:${f.lineNumber + 1}`;
        grouped.set(key, (grouped.get(key) ?? 0) + us);
      }
      return [...grouped]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([fn, us]) => ({
          fn,
          ms: Math.round(us / 1000),
          pct:
            Math.round((us / (profile.endTime - profile.startTime)) * 1000) /
            10,
        }));
    };
    console.log(
      JSON.stringify(
        {
          wallMs: (profile.endTime - profile.startTime) / 1000,
          self: summarize(self),
          inclusive: summarize(inclusive),
        },
        null,
        2,
      ),
    );
    break;
  }
} finally {
  if (profiling !== undefined)
    await send("Profiler.stop", {}, profiling).catch(() => {});
  await send("NodeWorker.disable").catch(() => {});
  // Close only the inspector opened for this diagnostic; defer until detached.
  await send("Runtime.evaluate", {
    expression:
      'setTimeout(()=>process.getBuiltinModule("inspector").close(),500); void 0',
  }).catch(() => {});
  ws.close();
}
