import { describe, expect, it } from "vitest";
import {
  uploadFrameData,
  type FrameUploadTarget,
} from "../../../src/client/render/frame/Upload";
import { UnitType } from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { packMotionPlans } from "../../../src/core/game/MotionPlans";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../../../src/core/network/ViewProtocol";
import {
  ViewSnapshot,
  emptyView,
} from "../../../src/server/simulation/ViewSnapshot";
import {
  makeGameView,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../../util/viewStubs";

describe("late spectator motion", () => {
  it("restores a boat path and continues warship position uploads after a snapshot", () => {
    const boat = makeUnitUpdate({
      id: 7,
      unitType: UnitType.TradeShip,
      pos: 3,
    });
    const warship = makeUnitUpdate({
      id: 8,
      unitType: UnitType.Warship,
      pos: 10,
    });
    const server = {
      map: () => ({
        width: () => 10,
        height: () => 10,
        tileState: () => 0,
        terrainByte: () => 0,
      }),
      ticks: () => 42,
      allPlayers: () => [{ toFullUpdate: () => makePlayerUpdate() }],
      units: () => [boat, warship].map((u) => ({ toUpdate: () => u })),
    };
    const snapshot = new ViewSnapshot({ game: server } as never);
    const plan = emptyView(40);
    plan.packedMotionPlans = packMotionPlans([
      {
        kind: "grid",
        unitId: 7,
        planId: 1,
        startTick: 40,
        ticksPerStep: 1,
        path: new Uint32Array([1, 2, 3, 4, 5, 6]),
      },
    ]);
    snapshot.record(plan);
    const viewer = makeGameView();
    for (const bytes of snapshot.packets()) {
      const packet = decodeViewPacket(bytes.buffer);
      if (packet.kind === "update") viewer.update(packet.update);
    }
    const captured: number[][] = [];
    const target = new Proxy(
      {},
      {
        get: (_, key) =>
          key === "updateUnits"
            ? (units: Map<number, { pos: number }>) =>
                captured.push([units.get(7)!.pos, units.get(8)!.pos])
            : () => {},
      },
    ) as FrameUploadTarget;
    uploadFrameData(target, viewer.frameData());
    for (let tick = 43; tick <= 44; tick++) {
      const live = emptyView(tick);
      live.updates[GameUpdateType.Unit] = [
        makeUnitUpdate({ ...warship, pos: tick - 32 }),
      ];
      const packet = decodeViewPacket(
        encodeViewPacket({ kind: "update", update: live }).buffer,
      );
      if (packet.kind === "update") viewer.update(packet.update);
      uploadFrameData(target, viewer.frameData());
    }
    expect(captured).toEqual([
      [3, 10],
      [4, 11],
      [5, 12],
    ]);
  });
});
