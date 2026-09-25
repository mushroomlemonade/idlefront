import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { ViewConnection } from "../../src/server/simulation/ViewConnection";

afterEach(() => vi.useRealTimers());
describe("view flow control", () => {
  it("streams a large live reveal as one bounded update without modifying buffers shared with another device", () => {
    vi.useFakeTimers();
    const ws = { readyState: 1, send: vi.fn() }, slow = vi.fn();
    const view = new ViewConnection(ws as unknown as WebSocket, slow);
    const packets = Array.from({ length: 1500 }, (_, i) => new Uint8Array([i % 255]));
    view.enqueueBatch(packets, 500);
    view.enqueue(new Uint8Array([255]), 501);
    for (let ack = 8; ack <= 1504; ack += 8) view.acknowledge(Math.min(ack, 1501));
    expect(slow).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1501);
    expect(packets.every(p => p instanceof Uint8Array)).toBe(true);
    expect(ws.send.mock.calls[1500][0][4]).toBe(255);
    view.stop();
  });
  it("streams snapshots larger than the live queue, preserving order and releasing chunks", () => {
    vi.useFakeTimers();
    const ws = { readyState: 1, send: vi.fn() };
    const slow = vi.fn();
    const view = new ViewConnection(ws as unknown as WebSocket, slow);
    const chunks = Array.from(
      { length: 1500 },
      (_, i) => new Uint8Array([i % 255]),
    );
    view.startSnapshot(chunks);
    view.enqueue(new Uint8Array([255]), 900);
    expect(ws.send).toHaveBeenCalledTimes(8);
    for (let ack = 8; ack <= 1504; ack += 8)
      view.acknowledge(Math.min(ack, 1501));
    expect(slow).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1501);
    for (let i = 0; i < 1500; i++) {
      expect(ws.send.mock.calls[i][0][4]).toBe(i % 255);
      expect(chunks[i]).toBeUndefined();
    }
    expect(ws.send.mock.calls[1500][0][4]).toBe(255);
    view.stop();
  });

  it("reports readiness only after the final snapshot frame is acknowledged", () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const view = new ViewConnection(
      { readyState: 1, send: vi.fn() } as unknown as WebSocket,
      vi.fn(),
      ready,
    );
    view.startSnapshot([
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);
    view.acknowledge(2);
    expect(ready).not.toHaveBeenCalled();
    view.acknowledge(3);
    expect(ready).toHaveBeenCalledOnce();
    view.acknowledge(3);
    expect(ready).toHaveBeenCalledOnce();
    view.stop();
  });

  it("still bounds live ticks while a snapshot is stalled", () => {
    vi.useFakeTimers();
    const slow = vi.fn();
    const view = new ViewConnection(
      { readyState: 1, send: vi.fn() } as unknown as WebSocket,
      slow,
    );
    view.startSnapshot(Array.from({ length: 1500 }, () => new Uint8Array([0])));
    for (let i = 0; i < 1025; i++) view.enqueue(new Uint8Array([1]), i);
    expect(slow).toHaveBeenCalledOnce();
    expect(view.isClosed).toBe(true);
  });
  it("pipelines eight frames, ignores invalid acknowledgements, then advances", () => {
    vi.useFakeTimers();
    const ws = { readyState: 1, send: vi.fn() };
    const slow = vi.fn();
    const view = new ViewConnection(ws as unknown as WebSocket, slow);
    for (let n = 0; n < 20; n++) view.enqueue(new Uint8Array([n]), n);
    expect(ws.send).toHaveBeenCalledTimes(8);
    view.acknowledge(99);
    expect(ws.send).toHaveBeenCalledTimes(8);
    view.acknowledge(4);
    expect(ws.send).toHaveBeenCalledTimes(12);
    view.acknowledge(3);
    expect(ws.send).toHaveBeenCalledTimes(12);
    view.stop();
  });
  it("new game ticks do not extend a stalled client's deadline", () => {
    vi.useFakeTimers();
    const slow = vi.fn();
    const view = new ViewConnection(
      { readyState: 1, send: vi.fn() } as unknown as WebSocket,
      slow,
    );
    for (let n = 0; n < 31; n++) {
      view.enqueue(new Uint8Array([0]), n);
      vi.advanceTimersByTime(1000);
    }
    expect(slow).toHaveBeenCalledOnce();
  });
});
