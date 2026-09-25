import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteWorkerClient } from "../../src/client/RemoteWorkerClient";
import type { Transport } from "../../src/client/Transport";
import type { ViewPacket } from "../../src/core/network/ViewProtocol";
import type { GameStartInfo } from "../../src/core/Schemas";
import { emptyView } from "../../src/server/simulation/ViewSnapshot";

afterEach(() => vi.useRealTimers());
describe("thin render client", () => {
  it("applies snapshots and live frames before acknowledging, resumes without replay", async () => {
    vi.useFakeTimers();
    let receive!: (sequence: number, packet: ViewPacket) => void;
    const send = vi.fn();
    const transport = {
      setViewReceiver: (receiver: typeof receive) => {
        receive = receiver;
      },
      sendViewMessage: send,
    };
    const client = new RemoteWorkerClient(
      { players: [], config: {} } as unknown as GameStartInfo,
      "test",
      transport as unknown as Transport,
    );
    const update = vi.fn();
    await client.initialize();
    client.start(update);
    client.subscribe();
    expect(client.isLoadingInitialView).toBe(true);
    expect(send).toHaveBeenLastCalledWith({
      type: "view_subscribe",
      afterTick: undefined,
    });
    receive(1, { kind: "update", snapshot: "begin", update: emptyView(5000) });
    receive(2, { kind: "update", snapshot: "end", update: emptyView(5000) });
    expect(update).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0].snapshotPhase).toBe("begin");
    expect(update.mock.calls[1][0].snapshotPhase).toBe("end");
    expect(client.isLoadingInitialView).toBe(false);
    receive(3, { kind: "update", update: emptyView(5001) });
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledTimes(3);
    client.subscribe();
    expect(send).toHaveBeenLastCalledWith({
      type: "view_subscribe",
      afterTick: 5001,
    });
    receive(1, { kind: "update", update: emptyView(5001) });
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ type: "view_ack", sequence: 1 });
    client.cleanup();
  });
  it("routes action RPCs and rejects outstanding requests when closing", async () => {
    let receive!: (sequence: number, packet: ViewPacket) => void;
    const send = vi.fn();
    const client = new RemoteWorkerClient(
      { players: [], config: {} } as unknown as GameStartInfo,
      "test",
      {
        setViewReceiver: (r: typeof receive) => {
          receive = r;
        },
        sendViewMessage: send,
      } as unknown as Transport,
    );
    await client.initialize();
    const pending = client.playerBorderTiles("player");
    const query = send.mock.calls[0][0].query;
    receive(0, {
      kind: "result",
      message: {
        type: "player_border_tiles_result",
        id: query.id,
        result: { borderTiles: new Set([5, 9]) },
      },
    });
    expect(await pending).toEqual({ borderTiles: new Set([5, 9]) });
    const closing = client.playerProfile(3);
    const rejected = expect(closing).rejects.toThrow("Game closed");
    client.cleanup();
    await rejected;
  });
  it("coalesces identical in-flight action queries", async () => {
    let receive!: (sequence: number, packet: ViewPacket) => void;
    const send = vi.fn();
    const client = new RemoteWorkerClient(
      { players: [], config: {} } as unknown as GameStartInfo,
      "test",
      {
        setViewReceiver: (r: typeof receive) => {
          receive = r;
        },
        sendViewMessage: send,
      } as unknown as Transport,
    );
    await client.initialize();

    const first = client.playerBorderTiles("player");
    const second = client.playerBorderTiles("player");
    expect(send).toHaveBeenCalledTimes(1);

    const query = send.mock.calls[0][0].query;
    receive(0, {
      kind: "result",
      message: {
        type: "player_border_tiles_result",
        id: query.id,
        result: { borderTiles: new Set([5, 9]) },
      },
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { borderTiles: new Set([5, 9]) },
      { borderTiles: new Set([5, 9]) },
    ]);
    client.cleanup();
  });
  it("acknowledges a frame even when presentation throws", async () => {
    vi.useFakeTimers();
    let receive!: (sequence: number, packet: ViewPacket) => void;
    const send = vi.fn();
    const client = new RemoteWorkerClient(
      { players: [], config: {} } as unknown as GameStartInfo,
      "test",
      {
        setViewReceiver: (r: typeof receive) => {
          receive = r;
        },
        sendViewMessage: send,
      } as unknown as Transport,
    );
    await client.initialize();
    client.start(() => {
      throw new Error("render failed");
    });

    receive(7, {
      kind: "update",
      snapshot: "part",
      update: emptyView(42),
    });
    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledWith({ type: "view_ack", sequence: 7 });
    client.cleanup();
  });
});
