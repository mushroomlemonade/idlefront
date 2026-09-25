import type { Application, RequestHandler } from "express";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type WorkerProxyTarget =
  | { kind: "not-worker" }
  | { kind: "invalid-worker" }
  | { kind: "worker"; index: number };

export interface WorkerReverseProxyOptions {
  numWorkers: number;
  hostname?: string;
  workerPort?: (index: number) => number;
}

/**
 * Resolve only canonical `/wN` path segments. Other application paths (most
 * importantly `/worlds`) remain available to the master's SPA fallback.
 */
export function resolveWorkerProxyTarget(
  requestTarget: string,
  numWorkers: number,
): WorkerProxyTarget {
  const match = /^\/w([0-9]+)(?=\/|\?|$)/.exec(requestTarget);
  if (!match) return { kind: "not-worker" };

  const rawIndex = match[1];
  const index = Number(rawIndex);
  if (
    !Number.isSafeInteger(index) ||
    String(index) !== rawIndex ||
    index < 0 ||
    index >= numWorkers
  ) {
    return { kind: "invalid-worker" };
  }
  return { kind: "worker", index };
}

/**
 * Attach an origin-local reverse proxy for worker-owned HTTP and WebSocket
 * routes. It must be installed before body parsers so request bodies (and any
 * credentials they contain) are streamed to the worker rather than retained
 * by the master.
 */
export function installWorkerReverseProxy(
  app: Application,
  server: http.Server,
  options: WorkerReverseProxyOptions,
): void {
  if (!Number.isSafeInteger(options.numWorkers) || options.numWorkers <= 0) {
    throw new Error("Worker reverse proxy requires a positive worker count");
  }
  const hostname = options.hostname ?? "127.0.0.1";
  const workerPort = options.workerPort ?? ((index: number) => 3001 + index);

  app.use(
    createWorkerHttpProxy({
      numWorkers: options.numWorkers,
      hostname,
      workerPort,
    }),
  );

  server.on("upgrade", (request, socket, head) => {
    const target = resolveWorkerProxyTarget(
      request.url ?? "",
      options.numWorkers,
    );
    if (target.kind === "not-worker") return;
    if (target.kind === "invalid-worker") {
      rejectSocket(socket, 404, "Not Found");
      return;
    }
    proxyWebSocket(request, socket, head, hostname, workerPort(target.index));
  });
}

interface ResolvedProxyOptions {
  numWorkers: number;
  hostname: string;
  workerPort: (index: number) => number;
}

function createWorkerHttpProxy(options: ResolvedProxyOptions): RequestHandler {
  return (request, response, next) => {
    const target = resolveWorkerProxyTarget(
      request.originalUrl || request.url,
      options.numWorkers,
    );
    if (target.kind === "not-worker") {
      next();
      return;
    }
    if (target.kind === "invalid-worker") {
      sendInvalidWorker(response);
      return;
    }
    proxyHttpRequest(
      request,
      response,
      options.hostname,
      options.workerPort(target.index),
    );
  };
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hostname: string,
  port: number,
): void {
  const upstream = http.request(
    {
      hostname,
      port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers, false),
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        forwardedHeaders(upstreamResponse.headers, false),
      );
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end('{"error":"Worker unavailable"}');
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function proxyWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  hostname: string,
  port: number,
): void {
  const upstream = http.request({
    hostname,
    port,
    method: request.method ?? "GET",
    path: request.url,
    headers: forwardedHeaders(request.headers, true),
  });

  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    writeRawResponseHead(socket, upstreamResponse);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on("response", (upstreamResponse) => {
    writeRawResponseHead(socket, upstreamResponse);
    upstreamResponse.pipe(socket);
  });
  upstream.on("error", () => rejectSocket(socket, 502, "Bad Gateway"));
  socket.on("close", () => upstream.destroy());
  upstream.end();
}

function forwardedHeaders(
  source: IncomingHttpHeaders,
  isUpgrade: boolean,
): IncomingHttpHeaders {
  const connectionTokens = new Set(
    String(source.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      connectionTokens.has(lowerName)
    ) {
      continue;
    }
    result[lowerName] = value;
  }
  if (isUpgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}

function sendInvalidWorker(response: ServerResponse): void {
  response.writeHead(404, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end('{"error":"Worker route not found"}');
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function writeRawResponseHead(socket: Duplex, response: IncomingMessage): void {
  if (socket.destroyed) return;
  const statusCode = response.statusCode ?? 502;
  const statusMessage = response.statusMessage ?? "Bad Gateway";
  let raw = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    raw += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
  }
  socket.write(`${raw}\r\n`);
}
