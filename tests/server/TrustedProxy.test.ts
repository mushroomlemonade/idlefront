import { describe, expect, it } from "vitest";
import {
  createTrustedProxyPredicate,
  isLoopbackProxyAddress,
} from "../../src/server/TrustedProxy";

describe("trusted proxy boundary", () => {
  it("trusts only the local Cloudflare Tunnel hop", () => {
    expect(isLoopbackProxyAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackProxyAddress("127.42.0.9")).toBe(true);
    expect(isLoopbackProxyAddress("::1")).toBe(true);
    expect(isLoopbackProxyAddress("::ffff:127.0.0.1")).toBe(true);

    expect(isLoopbackProxyAddress("192.168.50.25")).toBe(false);
    expect(isLoopbackProxyAddress("10.0.0.4")).toBe(false);
    expect(isLoopbackProxyAddress("203.0.113.9")).toBe(false);
    expect(isLoopbackProxyAddress("::ffff:203.0.113.9")).toBe(false);
  });

  it("trusts only the configured isolated Docker gateway", () => {
    const trusted = createTrustedProxyPredicate("172.30.0.1");
    expect(trusted("172.30.0.1")).toBe(true);
    expect(trusted("::ffff:172.30.0.1")).toBe(true);
    expect(trusted("172.30.0.2")).toBe(false);
    expect(trusted("192.168.50.25")).toBe(false);
    expect(() => createTrustedProxyPredicate("203.0.113.9")).toThrow(
      /private IPv4/,
    );
  });
});
