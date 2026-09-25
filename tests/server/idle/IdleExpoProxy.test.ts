import http from "node:http";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
// @ts-expect-error Standalone operational JavaScript has no declaration file.
import * as expoProxy from "../../../scripts/idle-expo-proxy.mjs";

const { createExpoPreviewProxy, expoPreviewPrefix } = expoProxy;

it("uses a stable secret-scoped path without embedding the preview password", () => {
  const a = expoPreviewPrefix("one secret");
  expect(a).toBe(expoPreviewPrefix("one secret"));
  expect(a).not.toBe(expoPreviewPrefix("another secret"));
  expect(a).toMatch(/^\/__expo\/[a-f0-9]{32}$/);
});

it("preserves Metro update protocol headers while rewriting the manifest", async () => {
  const incoming = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "expo-protocol-version": "0", "expo-sfv-version": "0" },
  });
  const outgoing = { setTimeout: vi.fn(), on: vi.fn(), destroy: vi.fn() };
  const get = vi
    .spyOn(http, "get")
    .mockImplementation((_url: any, _options: any, callback: any) => {
      queueMicrotask(() => {
        callback(incoming);
        incoming.end(
          JSON.stringify({
            launchAsset: {
              url: "http://localhost:8081/index.bundle?platform=ios",
            },
          }),
        );
      });
      return outgoing as any;
    });
  try {
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const res = { writeHead: vi.fn(), end: vi.fn((_body?: string) => done()) };
    const prefix = expoPreviewPrefix("test");
    createExpoPreviewProxy("test")(
      { method: "GET", headers: {} },
      res,
      new URL("https://example.com" + prefix + "/"),
    );
    await finished;
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "expo-protocol-version": "0",
        "expo-sfv-version": "0",
        "content-type": "application/expo+json",
      }),
    );
    const manifest = JSON.parse(res.end.mock.calls[0][0]!);
    expect(manifest.launchAsset.url).toContain(
      "https://atlas-dev.sightings.today" + prefix,
    );
  } finally {
    get.mockRestore();
  }
});

it("does not intercept game routes and rejects unkeyed/debug/write requests", () => {
  const proxy = createExpoPreviewProxy("one secret");
  const prefix = expoPreviewPrefix("one secret");
  const res = { writeHead: vi.fn(), end: vi.fn() };
  expect(
    proxy({ method: "GET" }, res, new URL("https://example.com/worlds")),
  ).toBe(false);
  expect(res.writeHead).not.toHaveBeenCalled();
  for (const [method, route] of [
    ["GET", "/__expo/wrong/"],
    ["GET", prefix + "/open-debugger"],
    ["POST", prefix + "/"],
    ["GET", prefix + "/assets/%2e%2e/secret"],
  ]) {
    expect(proxy({ method }, res, new URL("https://example.com" + route))).toBe(
      true,
    );
    expect(res.writeHead).toHaveBeenLastCalledWith(404);
  }
});
