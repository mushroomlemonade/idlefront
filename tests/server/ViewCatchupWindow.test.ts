import { afterEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { ViewConnection } from "../../src/server/simulation/ViewConnection";
afterEach(() => vi.useRealTimers());

it("limits large chunks by bytes and releases the budget on acknowledgement", () => {
  vi.useFakeTimers();
  const ws = { readyState: 1, send: vi.fn() };
  const slow = vi.fn();
  const connection = new ViewConnection(ws as unknown as WebSocket, slow);
  connection.startSnapshot(
    Array.from({ length: 80 }, () => new Uint8Array(190_000)),
  );
  expect(ws.send).toHaveBeenCalledTimes(11);
  connection.acknowledge(5);
  expect(ws.send).toHaveBeenCalledTimes(16);
  connection.acknowledge(500);
  expect(ws.send).toHaveBeenCalledTimes(16);
  connection.stop();
  vi.advanceTimersByTime(40_000);
  expect(slow).not.toHaveBeenCalled();
});

it("drains 2800 small snapshot chunks with live traffic under a simulated 150ms RTT", () => {
  vi.useFakeTimers();
  let sent = 0;
  const ws = {
    readyState: 1,
    send: vi.fn((bytes: Buffer) => {
      sent = bytes.readUInt32BE(0);
    }),
  };
  const slow = vi.fn(),
    ready = vi.fn();
  const connection = new ViewConnection(
    ws as unknown as WebSocket,
    slow,
    ready,
  );
  connection.startSnapshot(
    Array.from({ length: 2800 }, () => new Uint8Array(20_000)),
  );
  let elapsed = 0;
  while (!ready.mock.calls.length && elapsed < 20_000) {
    // 10 MiB/s of uncompressed live updates, including while snapshot loads.
    connection.enqueue(new Uint8Array(1_500_000), elapsed);
    const acknowledged = sent;
    vi.advanceTimersByTime(150);
    elapsed += 150;
    connection.acknowledge(acknowledged);
  }
  expect(ready).toHaveBeenCalledOnce();
  expect(elapsed).toBeLessThan(10_000);
  expect(slow).not.toHaveBeenCalled();
  connection.stop();
});

it("reports a stalled snapshot precisely and retains the 30-second deadline", () => {
  vi.useFakeTimers();
  const slow = vi.fn();
  const connection = new ViewConnection(
    { readyState: 1, send: vi.fn() } as unknown as WebSocket,
    slow,
  );
  connection.startSnapshot(
    Array.from({ length: 100 }, () => new Uint8Array(100)),
  );
  vi.advanceTimersByTime(30_000);
  expect(slow).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "ack-timeout",
      inFlightPackets: 64,
      snapshotRemaining: 36,
      acknowledged: 0,
    }),
  );
  expect(connection.isClosed).toBe(true);
  connection.acknowledge(64);
  vi.advanceTimersByTime(30_000);
  expect(slow).toHaveBeenCalledOnce();
});

it("identifies backlog overflow rather than misreporting an ACK timeout", () => {
  vi.useFakeTimers();
  const slow = vi.fn();
  const connection = new ViewConnection(
    { readyState: 1, send: vi.fn() } as unknown as WebSocket,
    slow,
  );
  connection.startSnapshot(
    Array.from({ length: 100 }, () => new Uint8Array(1)),
  );
  const packet = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 129; i++) connection.enqueue(packet, i);
  expect(slow).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "queue-bytes",
      queuedBytes: 128 * 1024 * 1024,
    }),
  );
});
