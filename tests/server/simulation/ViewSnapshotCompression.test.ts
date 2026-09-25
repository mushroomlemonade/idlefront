import { describe, expect, it } from "vitest";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import {
  packMotionPlans,
  unpackMotionPlans,
} from "../../../src/core/game/MotionPlans";
import { decodeViewPacket } from "../../../src/core/network/ViewProtocol";
import {
  emptyView,
  ViewSnapshot,
} from "../../../src/server/simulation/ViewSnapshot";

describe("ViewSnapshot run compression", () => {
  it("merges staggered label deltas into a complete rejoin snapshot", () => {
    const game = {
      map: () => ({
        width: () => 8,
        height: () => 1,
        tileState: () => 0,
        terrainByte: () => 128,
      }),
      ticks: () => 50,
      allPlayers: () => [],
      units: () => [],
    };
    const snapshot = new ViewSnapshot({ game } as never);
    const first = emptyView(31);
    first.playerNameViewData = { one: { x: 1, y: 2, size: 3 } };
    snapshot.record(first);
    const second = emptyView(32);
    second.playerNameViewData = { two: { x: 4, y: 5, size: 6 } };
    snapshot.record(second);
    snapshot.record(emptyView(33));
    const names = Object.assign(
      {},
      ...snapshot.packets().map((bytes) => {
        const packet = decodeViewPacket(bytes.buffer);
        return packet.kind === "update"
          ? (packet.update.playerNameViewData ?? {})
          : {};
      }),
    );
    expect(names).toEqual({
      ...first.playerNameViewData,
      ...second.playerNameViewData,
    });
    expect(Object.keys(first.playerNameViewData)).toEqual(["one"]);
  });
  it("restores ongoing motion for late viewers and prunes completed journeys", () => {
    let tick = 42;
    const game = {
      map: () => ({
        width: () => 8,
        height: () => 1,
        tileState: () => 0,
        terrainByte: () => 128,
      }),
      ticks: () => tick,
      allPlayers: () => [],
      units: () => [],
    };
    const snapshot = new ViewSnapshot({ game } as never);
    const update = emptyView(tick);
    update.packedMotionPlans = packMotionPlans([
      {
        kind: "grid",
        unitId: 7,
        planId: 1,
        startTick: 40,
        ticksPerStep: 2,
        path: new Uint32Array([1, 2, 3, 4]),
      },
      {
        kind: "train",
        engineUnitId: 8,
        planId: 2,
        startTick: 40,
        speed: 1,
        spacing: 2,
        carUnitIds: [],
        path: new Uint32Array([1, 2, 3, 4]),
      },
    ]);
    snapshot.record(update);
    const plans = () =>
      snapshot.packets().flatMap((bytes) => {
        const packet = decodeViewPacket(bytes.buffer);
        return packet.kind === "update" && packet.update.packedMotionPlans
          ? unpackMotionPlans(packet.update.packedMotionPlans)
          : [];
      });
    expect(plans().map((p) => p.kind)).toEqual(["grid", "train"]);
    const death = emptyView(tick);
    death.updates[GameUpdateType.Unit] = [{ id: 7, isActive: false } as never];
    snapshot.record(death);
    expect(plans().map((p) => p.kind)).toEqual(["train"]);
    tick = 50;
    expect(plans()).toEqual([]);
  });
  it("encodes contiguous equal ownership as compact tile-state runs", () => {
    const states = new Uint16Array([0, 9, 9, 9, 0, 12, 12, 0]);
    const map = {
      width: () => 8,
      height: () => 1,
      tileState: (ref: number) => states[ref],
      terrainByte: () => 0x80,
    };
    const game = {
      map: () => map,
      ticks: () => 42,
      allPlayers: () => [],
      units: () => [],
    };
    const snapshot = new ViewSnapshot({ game } as never);
    const update = emptyView(42);
    update.packedTileUpdates = new Uint32Array([
      1, 9, 2, 9, 3, 9, 5, 12, 6, 12,
    ]);
    snapshot.record(update);

    const decoded = snapshot
      .packets()
      .map((bytes) => decodeViewPacket(bytes.buffer))
      .filter(
        (packet) =>
          packet.kind === "update" &&
          packet.snapshot === "part" &&
          packet.update.packedTileRuns !== undefined,
      );
    expect(decoded).toHaveLength(1);
    const packet = decoded[0];
    if (packet.kind !== "update") throw new Error("wrong packet kind");
    expect([...packet.update.packedTileRuns!]).toEqual([1, 3, 9, 5, 2, 12]);
    expect(packet.update.packedTileUpdates).toHaveLength(0);
    expect(packet.update.updates[GameUpdateType.Player]).toEqual([]);
  });

  it("bounds large player rosters instead of creating one giant join frame", () => {
    const map = {
      width: () => 1,
      height: () => 1,
      tileState: () => 0,
      terrainByte: () => 0x80,
    };
    const players = Array.from({ length: 2_001 }, (_, id) => ({
      toFullUpdate: () => ({
        type: GameUpdateType.Player,
        id: `player-${id}`,
        clientID: id === 2_000 ? "connected-human" : null,
        name: `Player ${id} with a deliberately representative display name`,
        displayName: `Player ${id}`,
        smallID: id,
        embargoes: id === 0 ? new Set(["player-1"]) : new Set(),
      }),
    }));
    const game = {
      map: () => map,
      ticks: () => 42,
      allPlayers: () => players,
      units: () => [],
    };
    const snapshot = new ViewSnapshot({ game } as never);
    const packets = snapshot.packets();
    const decoded = packets.map((bytes) => decodeViewPacket(bytes.buffer));
    const playerPackets = decoded.filter(
      (packet) =>
        packet.kind === "update" &&
        packet.update.updates[GameUpdateType.Player].length > 0,
    );

    expect(
      Math.max(...packets.map((packet) => packet.byteLength)),
    ).toBeLessThan(128 * 1024);
    expect(
      playerPackets.every(
        (packet) =>
          packet.kind === "update" &&
          packet.update.updates[GameUpdateType.Player].length <= 64,
      ),
    ).toBe(true);
    const first = decoded[0];
    if (first.kind !== "update") throw new Error("wrong packet kind");
    expect(first.update.updates[GameUpdateType.Player][0].clientID).toBe(
      "connected-human",
    );
  });
});
