// Temporary bounded diagnostics in an existing simulation worker. Never pauses
// the debugger, modifies game state, queues intents, or restarts a server.
import { mkdir, writeFile } from "node:fs/promises";
const [gameID, action = "read"] = process.argv.slice(2);
if (
  !gameID ||
  !["install", "read", "remove", "limit-route-logs", "export-start"].includes(
    action,
  )
)
  throw new Error(
    "Usage: GAME_ID install|read|remove|limit-route-logs|export-start",
  );
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
  const key = session + ":" + message.id,
    p = pending.get(key);
  if (p) {
    pending.delete(key);
    clearTimeout(p.timer);
    if (message.error) p.reject(message.error);
    else p.resolve(message.result);
  }
}
ws.onmessage = (e) => receive(JSON.parse(e.data));
function send(method, params = {}, session = "") {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const key = session + ":" + id;
    pending.set(key, {
      resolve,
      reject,
      timer: setTimeout(() => {
        pending.delete(key);
        reject(new Error("Timeout " + method));
      }, 15000),
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
const install = `(()=>{
  if(globalThis.__idlefrontTickProbe)return {installed:true,alreadyPresent:true};
  const port=process.getBuiltinModule('worker_threads').parentPort;
  const original=port.postMessage,own=Object.hasOwn(port,'postMessage');
  const probe={data:new Float64Array(4096*7),count:0,last:0,installedAt:Date.now(),original,own};
  const wrapper=function(...args){
    const message=args[0];
    if(message?.recoveryProgress)probe.recovery=message.recoveryProgress;
    if(message?.ready)probe.ready=true;
    if(Number.isFinite(message?.tick)&&Number.isFinite(message?.duration)){
      const now=performance.now(),index=(probe.count%4096)*7;
      probe.data.set([message.tick,now,probe.last?now-probe.last:0,message.duration,message.coreDuration??0,message.encodingDuration??0,message.views?.length??0],index);
      probe.count++;probe.last=now;
    }
    return Reflect.apply(original,this,args);
  };
  probe.wrapper=wrapper;globalThis.__idlefrontTickProbe=probe;port.postMessage=wrapper;
  return {installed:true,capacity:4096};
})()`;
const read = `(()=>{
  const p=globalThis.__idlefrontTickProbe;if(!p)return {installed:false};
  const rows=[];for(let i=Math.max(0,p.count-4096);i<p.count;i++)rows.push(Array.from(p.data.subarray((i%4096)*7,(i%4096)*7+7)));
  const limit=globalThis.__idlefrontRouteLogLimit;
  return {installed:true,installedAt:p.installedAt,count:p.count,recovery:p.recovery,ready:p.ready,routeLogs:limit?{...limit.counts,installedPerf:limit.installedPerf}:undefined,columns:['tick','completedAtMs','intervalMs','workerMs','coreMs','encodingMs','viewers'],rows};
})()`;
const limitLogs = `(()=>{
  if(globalThis.__idlefrontRouteLogLimit)return {alreadyInstalled:true};
  const state={counts:{seen:0,suppressed:0},installedAt:Date.now(),installedPerf:performance.now(),originals:{}};
  const messages=new Set(['captured trade ship cannot find route','path not found to target']);
  for(const method of ['warn','log']){
    const original=console[method];state.originals[method]=original;
    const buckets=new Map();
    console[method]=function(...args){
      if(args.length!==1||!messages.has(args[0]))return Reflect.apply(original,this,args);
      state.counts.seen++;
      const message=args[0],now=Date.now(),bucket=buckets.get(message);
      if(bucket&&now>=bucket.time&&now-bucket.time<10000){bucket.skipped++;state.counts.suppressed++;return;}
      buckets.set(message,{time:now,skipped:0});
      return Reflect.apply(original,this,[bucket?.skipped?message+' ('+bucket.skipped+' repeats suppressed)':message]);
    };
  }
  globalThis.__idlefrontRouteLogLimit=state;
  return {installed:true,installedAt:state.installedAt,installedPerf:state.installedPerf};
})()`;
const remove = `(()=>{
  const p=globalThis.__idlefrontTickProbe;if(!p)return {removed:false};
  const port=process.getBuiltinModule('worker_threads').parentPort;
  if(port.postMessage!==p.wrapper)throw new Error('Diagnostic wrapper replaced elsewhere; refusing overwrite');
  if(p.own)port.postMessage=p.original;else delete port.postMessage;
  delete globalThis.__idlefrontTickProbe;return {removed:true,samples:p.count};
})()`;
try {
  await send("NodeWorker.enable", { waitForDebuggerOnStart: false });
  await new Promise((resolve) => setTimeout(resolve, 500));
  let found = false;
  for (const session of sessions) {
    const id = await send(
      "Runtime.evaluate",
      {
        expression:
          'process.getBuiltinModule("worker_threads").workerData?.start?.gameID',
        returnByValue: true,
      },
      session,
    );
    if (id.result?.value !== gameID) continue;
    found = true;
    const response = await send(
      "Runtime.evaluate",
      {
        expression:
          action === "install"
            ? install
            : action === "remove"
              ? remove
              : action === "limit-route-logs"
                ? limitLogs
                : action === "export-start"
                  ? 'process.getBuiltinModule("worker_threads").workerData.start'
                  : read,
        returnByValue: true,
      },
      session,
    );
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails));
    const data = response.result?.value;
    if (action === "export-start") {
      await mkdir(".dev-logs/profiles", { recursive: true });
      const filename =
        ".dev-logs/profiles/" + gameID + "-start-" + Date.now() + ".json";
      await writeFile(filename, JSON.stringify(data), { flag: "wx" });
      console.log(JSON.stringify({ file: filename, gameID: data.gameID }));
    } else if (action === "read" && data?.rows?.length) {
      await mkdir(".dev-logs/profiles", { recursive: true });
      const filename =
        ".dev-logs/profiles/" + gameID + "-cadence-" + Date.now() + ".json";
      await writeFile(filename, JSON.stringify(data));
      const rows = data.rows.filter((r) => r[2] > 0);
      const summary = (values) => {
        const sorted = [...values].sort((a, b) => a - b),
          q = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
        return {
          samples: sorted.length,
          mean: values.reduce((a, b) => a + b, 0) / values.length,
          p50: q(0.5),
          p95: q(0.95),
          p99: q(0.99),
          max: sorted.at(-1),
        };
      };
      console.log(
        JSON.stringify(
          {
            file: filename,
            totalSamples: data.count,
            intervalMs: summary(rows.map((r) => r[2])),
            workerMs: summary(rows.map((r) => r[3])),
            coreMs: summary(rows.map((r) => r[4])),
            betweenTurnsMs: summary(rows.map((r) => Math.max(0, r[2] - r[3]))),
            slowest: rows.sort((a, b) => b[2] - a[2]).slice(0, 12),
          },
          null,
          2,
        ),
      );
    } else console.log(JSON.stringify(data));
  }
  if (!found) throw new Error("Requested simulation worker not found");
} finally {
  await send("NodeWorker.disable").catch(() => {});
  await send("Runtime.evaluate", {
    expression:
      'setTimeout(()=>process.getBuiltinModule("inspector").close(),500);void 0',
  }).catch(() => {});
  ws.close();
}
