import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface GatewayModule {
  createPreviewGateway(options: {
    accessToken: string;
    origin: string;
    staticDir?: string;
    webOrigin?: string;
  }): http.Server;
}

const ACCESS_TOKEN = "preview-test-password-at-least-24-characters";
let originServer: http.Server;
let gatewayServer: http.Server;
let originUrl: string;
let gatewayUrl: string;
const originRequests: Array<{
  method: string;
  path: string;
  authorization?: string;
  forwardedFor?: string;
}> = [];

function listen(server: http.Server): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolveUrl(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function requestWithRawTarget(
  baseUrl: string,
  target: string,
  headers: http.OutgoingHttpHeaders,
): Promise<number> {
  const base = new URL(baseUrl);
  return new Promise((resolveStatus, reject) => {
    const request = http.request(
      {
        host: base.hostname,
        port: base.port,
        method: "GET",
        path: target,
        headers,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolveStatus(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

describe("idle public preview gateway", () => {
  beforeAll(async () => {
    originServer = http.createServer((req, res) => {
      originRequests.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        authorization:
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : undefined,
        forwardedFor:
          typeof req.headers["x-forwarded-for"] === "string"
            ? req.headers["x-forwarded-for"]
            : undefined,
      });
      if (req.url === "/idle/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<title>Pressure Atlas</title>");
        return;
      }
      if (req.url?.startsWith("/api/idle/state")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(418);
      res.end("origin route should not be public");
    });
    originUrl = await listen(originServer);
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), "scripts/idle-public-gateway.mjs"),
    ).href;
    const gatewayModule = (await import(moduleUrl)) as GatewayModule;
    gatewayServer = gatewayModule.createPreviewGateway({
      accessToken: ACCESS_TOKEN,
      origin: originUrl,
      staticDir: resolve(process.cwd(), "resources/idle"),
    });
    gatewayUrl = await listen(gatewayServer);
  });

  afterAll(async () => {
    await Promise.all([close(gatewayServer), close(originServer)]);
  });

  it("requires a preview login before serving the game", async () => {
    const protectedResponse = await fetch(`${gatewayUrl}/idle/`, {
      redirect: "manual",
    });
    expect(protectedResponse.status).toBe(302);
    expect(protectedResponse.headers.get("location")).toBe("/__preview/login");

    const loginPage = await fetch(`${gatewayUrl}/__preview/login`);
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("IdleFront");

    const failedLogin = await fetch(`${gatewayUrl}/__preview/login`, {
      method: "POST",
      body: new URLSearchParams({ password: "incorrect" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(failedLogin.status).toBe(401);
  });

  it("sets a secure cookie and exposes only the idle surface", async () => {
    const login = await fetch(`${gatewayUrl}/__preview/login`, {
      method: "POST",
      body: new URLSearchParams({ password: ACCESS_TOKEN }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/idle/");
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";", 1)[0];

    const game = await fetch(`${gatewayUrl}/idle/`, {
      headers: { cookie },
    });
    expect(game.status).toBe(200);
    expect(game.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(game.headers.get("x-frame-options")).toBe("DENY");
    expect(await game.text()).toContain("IdleFront");
    expect(originRequests.some((request) => request.path === "/idle/")).toBe(
      false,
    );

    const originCount = originRequests.length;
    const blockedAdmin = await fetch(`${gatewayUrl}/api/idle/admin/summary`, {
      headers: { cookie },
    });
    expect(blockedAdmin.status).toBe(404);
    expect(originRequests).toHaveLength(originCount);

    const blockedHealth = await fetch(`${gatewayUrl}/api/idle/health`, {
      headers: { cookie },
    });
    expect(blockedHealth.status).toBe(404);

    const missingAsset = await fetch(`${gatewayUrl}/idle/missing.js`, {
      headers: { cookie },
    });
    expect(missingAsset.status).toBe(404);

    const wrongMethod = await fetch(`${gatewayUrl}/api/idle/state`, {
      method: "POST",
      headers: { cookie },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(originRequests).toHaveLength(originCount);
  });

  it("preserves the player's bearer credential through the gateway", async () => {
    const login = await fetch(`${gatewayUrl}/__preview/login`, {
      method: "POST",
      body: new URLSearchParams({ password: ACCESS_TOKEN }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const response = await fetch(
      `${gatewayUrl}/api/idle/state?playerId=player-test-id`,
      {
        headers: {
          authorization: "Bearer player-session-token",
          "cf-connecting-ip": "203.0.113.5",
          cookie,
          "x-forwarded-for": "198.51.100.99",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(originRequests[originRequests.length - 1]).toMatchObject({
      path: "/api/idle/state?playerId=player-test-id",
      authorization: "Bearer player-session-token",
      forwardedFor: "203.0.113.5",
    });
  });

  it("rejects oversized API commands before contacting the authority", async () => {
    const login = await fetch(`${gatewayUrl}/__preview/login`, {
      method: "POST",
      body: new URLSearchParams({ password: ACCESS_TOKEN }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const originCount = originRequests.length;
    const response = await fetch(`${gatewayUrl}/api/idle/session`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ payload: "x".repeat(9000) }),
    });
    expect(response.status).toBe(413);
    expect(originRequests).toHaveLength(originCount);
  });

  it("rejects absolute-form request targets instead of proxying them", async () => {
    const login = await fetch(`${gatewayUrl}/__preview/login`, {
      method: "POST",
      body: new URLSearchParams({ password: ACCESS_TOKEN }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const originCount = originRequests.length;

    const status = await requestWithRawTarget(
      gatewayUrl,
      "http://169.254.169.254/api/idle/state?playerId=blocked",
      { cookie },
    );

    expect(status).toBe(400);
    expect(originRequests).toHaveLength(originCount);
  });

  it("can protect and proxy the current IdleFront web client", async () => {
    const webRequests: Array<{ path: string; cookie?: string }> = [];
    const webServer = http.createServer((req, res) => {
      webRequests.push({
        path: req.url ?? "/",
        cookie:
          typeof req.headers.cookie === "string"
            ? req.headers.cookie
            : undefined,
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<title>Current IdleFront</title>");
    });
    const webUrl = await listen(webServer);
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), "scripts/idle-public-gateway.mjs"),
    ).href;
    const gatewayModule = (await import(moduleUrl)) as GatewayModule;
    const webGateway = gatewayModule.createPreviewGateway({
      accessToken: ACCESS_TOKEN,
      origin: originUrl,
      webOrigin: webUrl,
    });
    const webGatewayUrl = await listen(webGateway);

    try {
      const protectedResponse = await fetch(`${webGatewayUrl}/`, {
        redirect: "manual",
      });
      expect(protectedResponse.status).toBe(302);
      expect(protectedResponse.headers.get("location")).toBe(
        "/__preview/login",
      );

      const login = await fetch(`${webGatewayUrl}/__preview/login`, {
        method: "POST",
        body: new URLSearchParams({ password: ACCESS_TOKEN }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
      });
      expect(login.status).toBe(303);
      expect(login.headers.get("location")).toBe("/");
      const previewCookie = (login.headers.get("set-cookie") ?? "").split(
        ";",
        1,
      )[0];

      const currentClient = await fetch(`${webGatewayUrl}/?ui-lab=1`, {
        headers: { cookie: `${previewCookie}; idlefront_session=player` },
      });
      expect(currentClient.status).toBe(200);
      expect(await currentClient.text()).toContain("Current IdleFront");
      expect(webRequests[webRequests.length - 1]).toEqual({
        path: "/?ui-lab=1",
        cookie: "idlefront_session=player",
      });
    } finally {
      await Promise.all([close(webGateway), close(webServer)]);
    }
  });
});
