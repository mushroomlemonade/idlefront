import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  installWorkerReverseProxy,
  resolveWorkerProxyTarget,
} from "../../src/server/WorkerReverseProxy";

const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function request(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
  } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const clientRequest = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end(options.body);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("worker reverse proxy target validation", () => {
  it("accepts only canonical in-range worker path segments", () => {
    expect(resolveWorkerProxyTarget("/w0", 2)).toEqual({
      kind: "worker",
      index: 0,
    });
    expect(resolveWorkerProxyTarget("/w1/game/id?live", 2)).toEqual({
      kind: "worker",
      index: 1,
    });
    expect(resolveWorkerProxyTarget("/w2/game/id", 2)).toEqual({
      kind: "invalid-worker",
    });
    expect(resolveWorkerProxyTarget("/w01/game/id", 2)).toEqual({
      kind: "invalid-worker",
    });
    expect(resolveWorkerProxyTarget("/worlds", 2)).toEqual({
      kind: "not-worker",
    });
  });
});

describe("worker reverse proxy transport", () => {
  it("streams HTTP bodies and end-to-end credentials without proxy credentials", async () => {
    let firstChunkArrived: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkArrived = resolve;
    });
    let received:
      | {
          url: string;
          authorization: string | undefined;
          cookie: string | undefined;
          proxyAuthorization: string | undefined;
          body: string;
        }
      | undefined;
    const worker = http.createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.once("data", () => firstChunkArrived?.());
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        received = {
          url: incoming.url ?? "",
          authorization: incoming.headers.authorization,
          cookie: incoming.headers.cookie,
          proxyAuthorization: incoming.headers["proxy-authorization"],
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(201, { "x-worker": "zero" });
        response.end("created");
      });
    });
    const workerPort = await listen(worker);
    const app = express();
    const master = http.createServer(app);
    installWorkerReverseProxy(app, master, {
      numWorkers: 1,
      workerPort: () => workerPort,
    });
    app.use((_incoming, response) => response.status(200).send("master spa"));
    const masterPort = await listen(master);

    const responsePromise = new Promise<{
      status: number;
      body: string;
      worker: string | undefined;
    }>((resolve, reject) => {
      const clientRequest = http.request(
        {
          hostname: "127.0.0.1",
          port: masterPort,
          path: "/w0/api/game/runtime_1?claim=true",
          method: "POST",
          headers: {
            authorization: "Bearer opaque",
            cookie: "session=opaque",
            "content-type": "application/octet-stream",
            "proxy-authorization": "must-not-cross",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              worker: response.headers["x-worker"] as string | undefined,
            }),
          );
        },
      );
      clientRequest.on("error", reject);
      clientRequest.write("first-");
      void firstChunk.then(() => clientRequest.end("second"));
    });

    await firstChunk;
    const response = await responsePromise;

    expect(received).toEqual({
      url: "/w0/api/game/runtime_1?claim=true",
      authorization: "Bearer opaque",
      cookie: "session=opaque",
      proxyAuthorization: undefined,
      body: "first-second",
    });
    expect(response).toEqual({
      status: 201,
      body: "created",
      worker: "zero",
    });
  });

  it("keeps master SPA routes local and rejects out-of-range workers", async () => {
    let workerRequests = 0;
    const worker = http.createServer((_incoming, response) => {
      workerRequests += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("worker game document");
    });
    const workerPort = await listen(worker);
    const app = express();
    const master = http.createServer(app);
    installWorkerReverseProxy(app, master, {
      numWorkers: 1,
      workerPort: () => workerPort,
    });
    app.use((_incoming, response) => response.status(200).send("master spa"));
    const masterPort = await listen(master);

    const game = await request(masterPort, "/w0/game/runtime_1?live");
    const worlds = await request(masterPort, "/worlds");
    const invalid = await request(masterPort, "/w1/game/runtime_1");

    expect(game.body).toBe("worker game document");
    expect(worlds.body).toBe("master spa");
    expect(invalid.status).toBe(404);
    expect(invalid.headers["cache-control"]).toBe("no-store");
    expect(workerRequests).toBe(1);
  });

  it("tunnels WebSocket upgrades to the selected worker", async () => {
    const worker = http.createServer();
    const workerSockets = new WebSocketServer({ server: worker });
    workerSockets.on("connection", (socket, incoming) => {
      socket.on("message", (message) =>
        socket.send(`${incoming.url}:${message.toString()}`),
      );
    });
    const workerPort = await listen(worker);
    const app = express();
    const master = http.createServer(app);
    installWorkerReverseProxy(app, master, {
      numWorkers: 1,
      workerPort: () => workerPort,
    });
    const masterPort = await listen(master);

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${masterPort}/w0?game=runtime_1`,
      );
      socket.on("open", () => socket.send("hello"));
      socket.on("message", (message) => {
        resolve(message.toString());
        socket.close();
      });
      socket.on("error", reject);
    });

    expect(reply).toBe("/w0?game=runtime_1:hello");
    workerSockets.close();
  });
});
