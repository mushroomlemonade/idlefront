import { expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../src/core/game/GameUpdates";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../../src/core/network/ViewProtocol";
import { ViewConnection } from "../../src/server/simulation/ViewConnection";
import {
  BoundedViewStateCompactor,
  compactViewState,
} from "../../src/server/simulation/ViewStateCompactor";
import {
  makeEmptyGu,
  makeGameView,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../util/viewStubs";

function packet(update: GameUpdateViewData) {
  return encodeViewPacket({ kind: "update", update });
}

it("caps aggregate compaction CPU across viewers and resumes its budget", () => {
  let now = 0;
  const merge = vi.fn(() => {
    now += 9;
    return new Uint8Array([1]);
  });
  const bounded = new BoundedViewStateCompactor(() => now, merge);
  const bytes = new Uint8Array();
  expect(bounded.compact(bytes, bytes)).toBeDefined();
  expect(bounded.compact(bytes, bytes)).toBeDefined();
  expect(bounded.compact(bytes, bytes)).toBeUndefined();
  expect(merge).toHaveBeenCalledTimes(2);
  now = 101;
  expect(bounded.compact(bytes, bytes)).toBeDefined();
  expect(bounded.metrics).toEqual({ attempts: 3, budgetSkips: 1, totalMs: 27 });
});
function state(tick: number) {
  const u = makeEmptyGu(tick);
  u.updates[GameUpdateType.Unit] = [
    makeUnitUpdate({ id: 7, pos: tick * 101, lastPos: (tick - 1) * 101 }),
  ];
  u.updates[GameUpdateType.Player] = [
    {
      type: GameUpdateType.Player,
      id: "player-a",
      troops: tick * 100,
      gold: BigInt(tick),
    },
  ];
  u.packedPlayerUpdates = new Float64Array([1, tick, tick * 10, tick * 100]);
  u.packedAttackUpdates = new Float64Array([1, 0, 0, tick * 3]);
  u.packedTileUpdates = new Uint32Array([1, tick]);
  return u;
}
it("compacts state while matching full client ingestion, including grid membership", () => {
  const original = makeGameView({ width: 1000, height: 1000 }),
    compacted = makeGameView({ width: 1000, height: 1000 });
  const start = makeEmptyGu(0);
  start.updates[GameUpdateType.Player] = [
    makePlayerUpdate({
      outgoingAttacks: [
        { id: "a", attackerID: 1, targetID: 2, retreating: false, troops: 1 },
      ],
    }),
  ];
  start.updates[GameUpdateType.Unit] = [makeUnitUpdate({ id: 7, pos: 0 })];
  original.update(structuredClone(start));
  compacted.update(structuredClone(start));
  let merged = packet(state(1));
  for (let i = 1; i <= 8; i++) {
    const u = state(i);
    original.update(u);
    if (i > 1)
      merged = compactViewState(merged, packet(u))! as Uint8Array<ArrayBuffer>;
  }
  expect(merged).toBeDefined();
  const decoded = decodeViewPacket(Uint8Array.from(merged).buffer);
  if (decoded.kind !== "update") throw new Error("Expected update");
  compacted.update(decoded.update);
  expect(compacted.frameData().units).toEqual(original.frameData().units);
  expect(compacted.player("player-a").troops()).toBe(
    original.player("player-a").troops(),
  );
  expect(decoded.update.packedAttackUpdates).toEqual(
    new Float64Array([1, 0, 0, 24]),
  );
  expect(
    compacted
      .nearbyUnits(808, 1, original.unit(7)!.type())
      .map((v) => v.unit.id()),
  ).toEqual([7]);
});

it("never merges across event, fog, lifecycle, motion, attack membership or unknown-player-field barriers", () => {
  const modifications: ((u: GameUpdateViewData) => void)[] = [
    (u) => {
      u.fog = {
        enabled: true,
        global: false,
        hiddenPlayers: new Uint16Array(),
        forgottenUnits: new Uint32Array(),
      };
    },
    (u) => {
      u.packedMotionPlans = new Uint32Array([1]);
    },
    (u) => {
      u.packedTerrainUpdates = new Uint32Array([1, 2]);
    },
    (u) => {
      u.packedNukeImpacts = new Uint32Array([1]);
    },
    (u) => {
      u.updates[GameUpdateType.AllianceExpired] = [
        { type: GameUpdateType.AllianceExpired, player1ID: 1, player2ID: 2 },
      ];
    },
    (u) => {
      u.updates[GameUpdateType.Unit][0].isActive = false;
    },
    (u) => {
      u.updates[GameUpdateType.Unit][0].ownerID = 4;
    },
    (u) => {
      u.updates[GameUpdateType.Player][0].outgoingAttacks = [];
    },
    (u) => {
      u.updates[GameUpdateType.Player][0].allies = [];
    },
  ];
  for (const modify of modifications) {
    const second = state(2);
    modify(second);
    expect(compactViewState(packet(state(1)), packet(second))).toBeUndefined();
  }
  expect(
    compactViewState(new Uint8Array([1]), packet(state(2))),
  ).toBeUndefined();
});

it("bounds catch-up compaction, preserves barriers and never mutates shared source packets", () => {
  const sent: Buffer[] = [];
  const ws = { readyState: 1, send: (b: Buffer) => sent.push(b) };
  const slow = vi.fn();
  const connection = new ViewConnection(
    ws as unknown as WebSocket,
    slow,
    undefined,
    compactViewState,
  );
  const source = Array.from({ length: 1000 }, (_, i) => packet(state(i + 1)));
  const saved = source.map((b) => Buffer.from(b));
  for (let i = 0; i < source.length; i++) connection.enqueue(source[i], i + 1);
  expect(connection.diagnostics().compactedFrames).toBeGreaterThan(800);
  expect(connection.diagnostics().queuedFrames).toBeLessThan(110);
  expect(connection.diagnostics().savedBytes).toBeGreaterThan(0);
  while (connection.diagnostics().queuedFrames)
    connection.acknowledge(sent[sent.length - 1].readUInt32BE(0));
  expect(slow).not.toHaveBeenCalled();
  expect(source.map((b) => Buffer.from(b))).toEqual(saved);
  const tail = decodeViewPacket(
    Uint8Array.from(sent[sent.length - 1].subarray(4)).buffer,
  );
  expect(tail.kind === "update" && tail.update.tick).toBe(1000);
  connection.stop();
});
