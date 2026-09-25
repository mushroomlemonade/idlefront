import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { GameEnv } from "../../src/core/configuration/Config";
import { GameType } from "../../src/core/game/Game";
import type { GameConfig } from "../../src/core/Schemas";
import { Client } from "../../src/server/Client";
import { GameServer, hashPersistentID } from "../../src/server/GameServer";
import { ServerEnv } from "../../src/server/ServerEnv";

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
}

describe("managed world controller connections", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  function setup() {
    vi.useFakeTimers();
    vi.spyOn(ServerEnv, "env").mockReturnValue(GameEnv.Prod);
    const log = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const seats = Array.from({ length: 5 }, (_, index) => ({
      clientID: `player0${index}`,
      persistentIdHash: hashPersistentID(`identity-${index}`),
      username: `Player ${index}`,
      clanTag: null,
    }));
    const game = new GameServer(
      "game1234",
      log as never,
      Date.now(),
      {
        gameType: GameType.Public,
        maxPlayers: 8,
        serverSimulation: false,
      } as GameConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        requestId: "world_test",
        expiresAt: Date.now() + 86_400_000,
        reservedSeats: seats,
      },
    );
    vi.spyOn(game as any, "startLobbyInfoBroadcast").mockImplementation(
      () => {},
    );
    const clients = seats.map(
      (seat, index) =>
        new Client(
          seat.clientID,
          `identity-${index}`,
          null,
          null,
          undefined,
          "192.168.1.10",
          seat.username,
          null,
          new Socket() as unknown as WebSocket,
          undefined,
          undefined,
          [],
        ),
    );
    return { game, clients };
  }

  it("keeps a managed world active beyond its pacing target", () => {
    const { game } = setup();
    Reflect.set(game, "_hasStarted", true);
    vi.setSystemTime(Date.now() + 3 * 86_400_000);
    expect(game.phase()).toBe("ACTIVE");
  });

  it("routes fog frames by authenticated seat rather than shared IP", () => {
    const { game, clients } = setup();
    const first = { enqueueBatch: vi.fn() }, second = { enqueueBatch: vi.fn() };
    Reflect.set(game, "viewConnections", new Map([[clients[0].ws,first],[clients[1].ws,second]]));
    Reflect.set(game, "viewSeats", new Map([[clients[0].ws,clients[0].clientID],[clients[1].ws,clients[1].clientID]]));
    Reflect.get(game,"publishView").call(game, { tick:1,bytes:new Uint8Array([99]),views:[
      {clientID:clients[0].clientID,bytes:new Uint8Array([1])},
      {clientID:clients[1].clientID,bytes:new Uint8Array([2])},
    ]});
    expect(first.enqueueBatch).toHaveBeenCalledExactlyOnceWith([new Uint8Array([1])],1);
    expect(second.enqueueBatch).toHaveBeenCalledExactlyOnceWith([new Uint8Array([2])],1);
  });

  it("does not present a failed simulation as a live rejoin", () => {
    const { game } = setup();
    Reflect.set(game, "simulationFailed", true);
    const socket = new Socket();
    (game as any).sendStartGameMsg(socket, 0);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: "error",
      error: "This match stopped and needs server recovery. It is not currently running.",
    });
  });

  it("admits five different nations behind the same IP in production", () => {
    const { game, clients } = setup();
    for (const client of clients)
      expect(game.joinClient(client)).toBe("joined");
    expect(
      new Set(
        clients.map((client) =>
          game.getClientIdForPersistentId(client.persistentID),
        ),
      ).size,
    ).toBe(5);
  });

  it("rejects the second controller without kicking the first", () => {
    const { game, clients } = setup();
    const original = clients[0];
    game.joinClient(original);
    const oldSocket = original.ws;
    const second = new Socket();
    expect(
      game.rejoinClient(second as unknown as WebSocket, original.persistentID),
    ).toBe(true);
    expect(second.close).toHaveBeenCalledWith(4009, expect.any(String));
    expect(oldSocket.close).not.toHaveBeenCalled();
    expect(original.ws).toBe(oldSocket);
  });

  it("reclaims a disconnected nation with the same client ID", () => {
    const { game, clients } = setup();
    const original = clients[0];
    game.joinClient(original);
    // A running match keeps its nation and reconnect index after disconnect.
    vi.spyOn(game, "hasStarted").mockReturnValue(true);
    original.ws.close();
    const second = new Socket();
    expect(
      game.rejoinClient(second as unknown as WebSocket, original.persistentID),
    ).toBe(true);
    expect(second.close).not.toHaveBeenCalled();
    expect(original.ws).toBe(second);
    expect(game.getClientIdForPersistentId(original.persistentID)).toBe(
      original.clientID,
    );
  });

  it("releases an unresponsive controller after thirty seconds", () => {
    const { game, clients } = setup();
    const original = clients[0];
    game.joinClient(original);
    vi.advanceTimersByTime(30_001);
    const replacement = new Socket();
    expect(
      game.rejoinClient(
        replacement as unknown as WebSocket,
        original.persistentID,
      ),
    ).toBe(true);
    expect(original.ws).toBe(replacement);
  });
});
