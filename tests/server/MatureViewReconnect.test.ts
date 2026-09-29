import { expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { UnitType } from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../../src/core/network/ViewProtocol";
import { ViewConnection } from "../../src/server/simulation/ViewConnection";
import { ViewSnapshot } from "../../src/server/simulation/ViewSnapshot";
import { compactViewState } from "../../src/server/simulation/ViewStateCompactor";
import {
  makeEmptyGu,
  makeGameView,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../util/viewStubs";

it("reconnects repeatedly to a synthetic mature snapshot and drains live state without losing units", () => {
  const count = 12000,
    baseTick = 288000;
  const units = Array.from({ length: count }, (_, id) =>
    makeUnitUpdate({
      id: id + 1,
      unitType: id % 3 ? UnitType.Warship : UnitType.Port,
      pos: id % 1_000_000,
      lastPos: id % 1_000_000,
    }),
  );
  const game = {
    map: () => ({
      width: () => 1000,
      height: () => 1000,
      tileState: () => 0,
      terrainByte: () => 0,
    }),
    ticks: () => baseTick,
    allPlayers: () => [{ toFullUpdate: () => makePlayerUpdate() }],
    units: () => units.map((unit) => ({ toUpdate: () => unit })),
  };
  const snapshot = new ViewSnapshot({ game } as never);
  for (let reconnect = 0; reconnect < 3; reconnect++) {
    const client = makeGameView({ width: 1000, height: 1000 });
    const frames: Buffer[] = [];
    let consumed = 0;
    const ws = { readyState: 1, send: (bytes: Buffer) => frames.push(bytes) };
    const slow = vi.fn(),
      ready = vi.fn();
    const connection = new ViewConnection(
      ws as unknown as WebSocket,
      slow,
      ready,
      compactViewState,
    );
    connection.startSnapshot(snapshot.packets());
    for (let tick = 1; tick <= 30; tick++) {
      const update = makeEmptyGu(baseTick + tick);
      update.updates[GameUpdateType.Unit] = units
        .slice(0, 64)
        .filter((u) => u.unitType === UnitType.Warship)
        .map((u) => ({ ...u, pos: u.pos + tick * 1000 }));
      update.packedPlayerUpdates = new Float64Array([
        1,
        5000,
        tick * 100,
        tick * 1000,
      ]);
      connection.enqueue(
        encodeViewPacket({ kind: "update", update }),
        update.tick,
      );
    }
    while (consumed < frames.length) {
      const end = frames.length;
      for (; consumed < end; consumed++) {
        const packet = decodeViewPacket(
          Uint8Array.from(frames[consumed].subarray(4)).buffer,
        );
        if (packet.kind !== "update") throw new Error("Unexpected packet");
        packet.update.snapshotPhase = packet.snapshot;
        client.update(packet.update);
      }
      connection.acknowledge(frames[end - 1].readUInt32BE(0));
    }
    expect(ready).toHaveBeenCalledOnce();
    expect(slow).not.toHaveBeenCalled();
    expect(client.ticks()).toBe(baseTick + 30);
    expect(client.units()).toHaveLength(count);
    expect(client.unit(2)!.tile()).toBe(30001);
    expect(client.player("player-a").troops()).toBe(30000);
    expect(connection.diagnostics().queuedBytes).toBe(0);
    connection.stop();
  }
}, 30000);
