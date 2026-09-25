import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createExpoPreviewProxy } from "./idle-expo-proxy.mjs";

const COOKIE_NAME = "__Host-pressure_atlas_preview";
const LOGIN_PATH = "/__preview/login";
const MAX_LOGIN_BODY_BYTES = 4096;
const MAX_API_BODY_BYTES = 8192;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const MAX_LOGIN_CLIENTS = 10_000;
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

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalSecret(left, right) {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

function cookieValue(accessToken) {
  return digest(`pressure-atlas-preview:${accessToken}`).toString("base64url");
}

function parseCookies(header) {
  const result = new Map();
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) result.set(key, value);
  }
  return result;
}

function forwardedCookieHeader(header) {
  return String(header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf("=");
      return separator > 0 && part.slice(0, separator).trim() !== COOKIE_NAME;
    })
    .join("; ");
}

function isApiPath(pathname) {
  return pathname.startsWith("/api/");
}

function routeFor(method, pathname) {
  if ((method === "GET" || method === "HEAD") && pathname === "/") {
    return "redirect";
  }
  if (pathname === "/idle") {
    return method === "GET" || method === "HEAD"
      ? "idle-redirect"
      : "method-denied";
  }
  const staticFile = new Map([
    ["/idle/", "index.html"],
    ["/idle/index.html", "index.html"],
    ["/idle/app.js", "app.js"],
    ["/idle/style.css", "style.css"],
  ]).get(pathname);
  if (staticFile) {
    return method === "GET" || method === "HEAD"
      ? `static:${staticFile}`
      : "method-denied";
  }
  const apiMethods = new Map([
    ["/api/idle/session", "POST"],
    ["/api/idle/state", "GET"],
    ["/api/idle/tap", "POST"],
  ]);
  const expectedMethod = apiMethods.get(pathname);
  if (expectedMethod) {
    return method === expectedMethod ? "proxy" : "method-denied";
  }
  return "deny";
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    ...securityHeaders(),
    "cache-control": "no-store",
    "content-length": String(payload.length),
    ...headers,
  });
  res.end(payload);
}

function loginDocument(errorMessage = "") {
  const error = errorMessage
    ? `<p class="error" role="alert">${errorMessage}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>IdleFront preview</title>
    <style>
      :root { color-scheme: dark; font-family: ui-rounded, system-ui, sans-serif; background: #081621; color: #f7f4e8; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom)); background: radial-gradient(circle at 50% 0%, #173952, #081621 62%); }
      main { width: min(100%, 420px); padding: 28px; border: 1px solid #ffffff22; border-radius: 24px; background: #102838ee; box-shadow: 0 24px 80px #0008; }
      h1 { margin: 0 0 8px; font-size: clamp(1.8rem, 8vw, 2.5rem); }
      p { color: #c9d7df; line-height: 1.5; }
      label { display: grid; gap: 8px; font-weight: 700; }
      input, button { width: 100%; min-height: 50px; border-radius: 14px; font: inherit; }
      input { border: 1px solid #ffffff30; background: #07131c; color: #fff; padding: 0 14px; }
      button { margin-top: 14px; border: 0; background: #f6c453; color: #15202a; font-weight: 900; }
      .error { color: #ffad9f; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>IdleFront</h1>
      <p>This development world is private. Enter the preview password once on this device.</p>
      ${error}
      <form method="post" action="${LOGIN_PATH}">
        <label>Preview password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
        <button type="submit">Enter the world</button>
      </form>
    </main>
  </body>
</html>`;
}

function readBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("REQUEST_BODY_TOO_LARGE"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientKey(req) {
  const forwarded = String(req.headers["cf-connecting-ip"] ?? "").trim();
  const address = isIP(forwarded)
    ? forwarded
    : (req.socket.remoteAddress ?? "unknown");
  return digest(address).toString("hex");
}

function proxyHeaders(req, origin) {
  const result = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === "cookie" ||
      lowerName === "cf-access-jwt-assertion" ||
      lowerName === "cf-access-authenticated-user-email"
    ) {
      continue;
    }
    result[name] = value;
  }
  result.host = origin.host;
  const forwardedCookies = forwardedCookieHeader(req.headers.cookie);
  if (forwardedCookies) result.cookie = forwardedCookies;
  result["x-forwarded-host"] = req.headers.host ?? "";
  const connectingIp = String(req.headers["cf-connecting-ip"] ?? "").trim();
  result["x-forwarded-for"] = isIP(connectingIp)
    ? connectingIp
    : (req.socket.remoteAddress ?? "127.0.0.1");
  return result;
}

function proxyResponseHeaders(source) {
  const headers = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase() === "x-powered-by"
    ) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

function requireLoopbackOrigin(value, label) {
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(origin.hostname)
  ) {
    throw new Error(`${label} must be a loopback HTTP URL`);
  }
  return origin;
}

const IDLE_CONTENT_TYPES = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
};

export function createPreviewGateway(options = {}) {
  const accessToken =
    options.accessToken ?? process.env.IDLE_PREVIEW_ACCESS_TOKEN ?? "";
  if (accessToken.length < 24) {
    throw new Error("IDLE_PREVIEW_ACCESS_TOKEN must be at least 24 characters");
  }
  const origin = requireLoopbackOrigin(
    options.origin ??
      process.env.IDLE_PREVIEW_ORIGIN ??
      "http://127.0.0.1:3000",
    "Idle preview origin",
  );
  const webOriginValue =
    options.webOrigin ?? process.env.IDLE_PREVIEW_WEB_ORIGIN ?? "";
  const webOrigin = webOriginValue
    ? requireLoopbackOrigin(webOriginValue, "Idle preview web origin")
    : undefined;
  const staticDir = path.resolve(
    options.staticDir ??
      process.env.IDLE_PREVIEW_STATIC_DIR ??
      path.resolve(process.cwd(), "resources/idle"),
  );
  const expectedCookie = cookieValue(accessToken);
  const proxyExpo = createExpoPreviewProxy(accessToken);
  const failedLogins = new Map();

  function authenticated(req) {
    const supplied = parseCookies(req.headers.cookie).get(COOKIE_NAME) ?? "";
    return equalSecret(supplied, expectedCookie);
  }

  function recordLoginFailure(req) {
    const now = Date.now();
    const key = clientKey(req);
    if (!failedLogins.has(key) && failedLogins.size >= MAX_LOGIN_CLIENTS) {
      const oldestKey = failedLogins.keys().next().value;
      if (oldestKey !== undefined) failedLogins.delete(oldestKey);
    }
    const recent = (failedLogins.get(key) ?? []).filter(
      (timestamp) => now - timestamp < LOGIN_WINDOW_MS,
    );
    recent.push(now);
    failedLogins.set(key, recent);
    return recent.length;
  }

  function loginBlocked(req) {
    const now = Date.now();
    const key = clientKey(req);
    const recent = (failedLogins.get(key) ?? []).filter(
      (timestamp) => now - timestamp < LOGIN_WINDOW_MS,
    );
    if (recent.length === 0) failedLogins.delete(key);
    else failedLogins.set(key, recent);
    return recent.length >= MAX_LOGIN_FAILURES;
  }

  async function proxy(req, res, requestUrl) {
    const target = new URL(origin.href);
    target.pathname = requestUrl.pathname;
    target.search = requestUrl.search;
    target.hash = "";
    let body;
    if (req.method === "POST") {
      const declaredLength = Number(req.headers["content-length"] ?? "0");
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_API_BODY_BYTES
      ) {
        send(res, 413, "Request body was too large", {
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      try {
        body = await readBoundedBody(req, MAX_API_BODY_BYTES);
      } catch {
        send(res, 413, "Request body was too large", {
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
    }
    const headers = proxyHeaders(req, origin);
    if (body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const upstream = http.request(
      target,
      {
        method: req.method,
        headers,
      },
      (upstreamResponse) => {
        const headers = proxyResponseHeaders(upstreamResponse.headers);
        Object.assign(headers, securityHeaders());
        res.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        send(
          res,
          502,
          JSON.stringify({
            error: {
              code: "PREVIEW_ORIGIN_UNAVAILABLE",
              message: "The development world is restarting",
            },
          }),
          { "content-type": "application/json; charset=utf-8" },
        );
      } else {
        res.destroy();
      }
    });
    if (body === undefined) upstream.end();
    else upstream.end(body);
  }

  function proxyWeb(req, res, requestUrl) {
    const target = new URL(webOrigin.href);
    target.pathname = requestUrl.pathname;
    target.search = requestUrl.search;
    target.hash = "";
    const upstream = http.request(
      target,
      {
        method: req.method,
        headers: proxyHeaders(req, webOrigin),
      },
      (upstreamResponse) => {
        const headers = proxyResponseHeaders(upstreamResponse.headers);
        Object.assign(headers, securityHeaders());
        res.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        send(res, 502, "The IdleFront client is restarting", {
          "content-type": "text/plain; charset=utf-8",
        });
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  }

  function rejectUpgrade(socket, status, message) {
    const payload = Buffer.from(message, "utf8");
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${payload.length}\r\n\r\n${message}`,
    );
  }

  function proxyWebUpgrade(req, socket, head) {
    if (!webOrigin || !authenticated(req)) {
      rejectUpgrade(socket, "401 Unauthorized", "Preview login is required");
      return;
    }
    let requestUrl;
    try {
      const rawTarget = req.url ?? "/";
      if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
        throw new Error("Invalid request target");
      }
      requestUrl = new URL(rawTarget, "http://preview.invalid");
    } catch {
      rejectUpgrade(socket, "400 Bad Request", "Invalid request target");
      return;
    }
    const target = new URL(webOrigin.href);
    target.pathname = requestUrl.pathname;
    target.search = requestUrl.search;
    const headers = proxyHeaders(req, webOrigin);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade ?? "websocket";
    const upstream = http.request(target, {
      method: req.method,
      headers,
    });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      const statusLine = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`;
      const headerLines = [];
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          headerLines.push(`${name}: ${item}`);
        }
      }
      socket.write(`${statusLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on("response", (response) => {
      response.resume();
      rejectUpgrade(socket, "502 Bad Gateway", "WebSocket upgrade failed");
    });
    upstream.on("error", () => {
      rejectUpgrade(
        socket,
        "502 Bad Gateway",
        "The IdleFront client is restarting",
      );
    });
    upstream.end();
  }

  async function serveIdleFile(req, res, fileName) {
    try {
      const payload = await readFile(path.join(staticDir, fileName));
      const headers = {
        ...securityHeaders(),
        "cache-control": "no-cache",
        "content-length": String(payload.length),
        "content-type": IDLE_CONTENT_TYPES[fileName],
      };
      if (fileName === "index.html") {
        headers["content-security-policy"] =
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";
      }
      res.writeHead(200, headers);
      if (req.method === "HEAD") res.end();
      else res.end(payload);
    } catch {
      send(res, 503, "Preview assets are unavailable", {
        "content-type": "text/plain; charset=utf-8",
      });
    }
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const rawTarget = req.url ?? "/";
    let requestUrl;
    try {
      if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
        throw new Error("Request target must use origin form");
      }
      requestUrl = new URL(rawTarget, "http://preview.invalid");
      if (requestUrl.origin !== "http://preview.invalid") {
        throw new Error("Request target escaped the preview origin");
      }
    } catch {
      send(res, 400, "Invalid request target", {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }
    const pathname = requestUrl.pathname;

    if (proxyExpo(req, res, requestUrl)) return;

    if (pathname === LOGIN_PATH && method === "GET") {
      send(res, 200, loginDocument(), {
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
      });
      return;
    }

    if (pathname === LOGIN_PATH && method === "POST") {
      if (loginBlocked(req)) {
        send(res, 429, loginDocument("Too many attempts. Try again later."), {
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "content-type": "text/html; charset=utf-8",
          "retry-after": "900",
        });
        return;
      }
      try {
        const body = await readBoundedBody(req, MAX_LOGIN_BODY_BYTES);
        const submitted = new URLSearchParams(body).get("password") ?? "";
        if (!equalSecret(submitted, accessToken)) {
          recordLoginFailure(req);
          send(res, 401, loginDocument("That password did not match."), {
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            "content-type": "text/html; charset=utf-8",
          });
          return;
        }
        failedLogins.delete(clientKey(req));
        res.writeHead(303, {
          ...securityHeaders(),
          "cache-control": "no-store",
          location: webOrigin ? "/" : "/idle/",
          "set-cookie": `${COOKIE_NAME}=${expectedCookie}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`,
        });
        res.end();
      } catch {
        send(res, 413, "Login request was too large", {
          "content-type": "text/plain; charset=utf-8",
        });
      }
      return;
    }

    if (req.headers.upgrade) {
      send(res, 404, "Not found", {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (webOrigin) {
      if (!authenticated(req)) {
        if (isApiPath(pathname)) {
          send(
            res,
            401,
            JSON.stringify({
              error: {
                code: "PREVIEW_LOGIN_REQUIRED",
                message: "Preview login is required",
              },
            }),
            { "content-type": "application/json; charset=utf-8" },
          );
        } else {
          res.writeHead(302, {
            ...securityHeaders(),
            "cache-control": "no-store",
            location: LOGIN_PATH,
          });
          res.end();
        }
        return;
      }
      proxyWeb(req, res, requestUrl);
      return;
    }

    const route = routeFor(method, pathname);
    if (route === "deny") {
      send(res, 404, "Not found", {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }
    if (route === "method-denied") {
      const allow = pathname.startsWith("/idle")
        ? "GET, HEAD"
        : pathname === "/api/idle/state"
          ? "GET"
          : "POST";
      send(res, 405, "Method not allowed", {
        allow,
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (!authenticated(req)) {
      if (isApiPath(pathname)) {
        send(
          res,
          401,
          JSON.stringify({
            error: {
              code: "PREVIEW_LOGIN_REQUIRED",
              message: "Preview login is required",
            },
          }),
          { "content-type": "application/json; charset=utf-8" },
        );
      } else {
        res.writeHead(302, {
          ...securityHeaders(),
          "cache-control": "no-store",
          location: LOGIN_PATH,
        });
        res.end();
      }
      return;
    }

    if (route === "redirect") {
      res.writeHead(302, {
        ...securityHeaders(),
        "cache-control": "no-store",
        location: "/idle/",
      });
      res.end();
      return;
    }
    if (route === "idle-redirect") {
      res.writeHead(308, {
        ...securityHeaders(),
        "cache-control": "no-store",
        location: "/idle/",
      });
      res.end();
      return;
    }
    if (route.startsWith("static:")) {
      await serveIdleFile(req, res, route.slice("static:".length));
      return;
    }
    await proxy(req, res, requestUrl);
  });
  if (webOrigin) server.on("upgrade", proxyWebUpgrade);
  return server;
}

export async function startPreviewGateway(options = {}) {
  const host = options.host ?? process.env.IDLE_PREVIEW_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.IDLE_PREVIEW_PORT ?? "3100");
  if (
    host !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Idle preview gateway must use loopback and a valid port");
  }
  const server = createPreviewGateway(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  startPreviewGateway()
    .then((server) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 3100;
      process.stdout.write(
        `Pressure Atlas preview gateway listening on 127.0.0.1:${port}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `Pressure Atlas preview gateway failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
