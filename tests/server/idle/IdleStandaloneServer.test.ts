import { mkdtempSync, rmSync } from "fs";
import http from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdleService } from "../../../src/server/idle";
import { createStandaloneIdleApp } from "../../../src/server/idle/StandaloneServer";

describe("standalone idle authority", () => {
  let directory: string;
  let service: IdleService;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "idle-standalone-test-"));
    service = new IdleService({ dbPath: join(directory, "idle.sqlite") });
    server = http.createServer(createStandaloneIdleApp(service));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("serves only the loopback idle API", async () => {
    const health = await fetch(`${baseUrl}/api/idle/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-powered-by")).toBeNull();

    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(404);

    const admin = await fetch(`${baseUrl}/api/idle/admin/summary`);
    expect(admin.status).toBe(404);
  });

  it("rejects oversized API bodies before they reach SQLite", async () => {
    const response = await fetch(`${baseUrl}/api/idle/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: "x".repeat(9000) }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REQUEST_TOO_LARGE" },
    });
  });
});
