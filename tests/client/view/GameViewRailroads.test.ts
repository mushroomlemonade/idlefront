import { describe, expect, it } from "vitest";
import {
  uploadFrameData,
  type FrameUploadTarget,
} from "../../../src/client/render/frame/Upload";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../../../src/core/network/ViewProtocol";
import { makeEmptyGu, makeGameView } from "../../util/viewStubs";

function captureRoadUploads() {
  const uploads: { refs: number[]; values: number[] }[] = [];
  const target = new Proxy(
    {},
    {
      get: (_target, method) =>
        method === "uploadRailroadState"
          ? (state: Uint8Array, refs: readonly number[]) =>
              uploads.push({
                refs: [...refs],
                values: refs.map((ref) => state[ref]),
              })
          : () => {},
    },
  ) as FrameUploadTarget;
  return { target, uploads };
}

describe("GameView railroad upload lifecycle", () => {
  it("keeps sparse road changes alive until the renderer consumes each tick", () => {
    const game = makeGameView();
    const { target, uploads } = captureRoadUploads();
    const construction = makeEmptyGu(1);
    construction.updates[GameUpdateType.RailroadConstructionEvent] = [
      {
        type: GameUpdateType.RailroadConstructionEvent,
        id: 7,
        tiles: [11, 12, 13, 14, 15, 16, 17, 18],
      },
    ];

    game.update(construction);
    uploadFrameData(target, game.frameData());
    expect(uploads[0]).toEqual({
      refs: [11, 12, 13, 16, 17, 18],
      values: [2, 2, 2, 2, 2, 2],
    });

    game.update(makeEmptyGu(2));
    uploadFrameData(target, game.frameData());
    expect(uploads[1]).toEqual({ refs: [14, 15], values: [2, 2] });

    game.update(makeEmptyGu(3));
    uploadFrameData(target, game.frameData());
    expect(uploads).toHaveLength(2);

    const destruction = makeEmptyGu(4);
    destruction.updates[GameUpdateType.RailroadDestructionEvent] = [
      { type: GameUpdateType.RailroadDestructionEvent, id: 7 },
    ];
    game.update(destruction);
    uploadFrameData(target, game.frameData());
    expect(uploads[2]).toEqual({
      refs: [11, 12, 13, 14, 15, 16, 17, 18],
      values: Array<number>(8).fill(0),
    });
  });

  it("uploads existing roads restored through an authoritative snapshot", () => {
    const game = makeGameView();
    const { target, uploads } = captureRoadUploads();
    const update = makeEmptyGu(5000);
    update.pendingTurns = 2;
    update.updates[GameUpdateType.RailroadConstructionEvent] = [
      {
        type: GameUpdateType.RailroadConstructionEvent,
        id: 9,
        tiles: [21, 22, 23],
      },
    ];
    const packet = decodeViewPacket(
      encodeViewPacket({ kind: "update", snapshot: "begin", update }).buffer,
    );
    if (packet.kind !== "update") throw new Error("Expected snapshot update");

    game.update(packet.update);
    uploadFrameData(target, game.frameData());
    expect(uploads).toEqual([{ refs: [21, 22, 23], values: [2, 2, 2] }]);

    // Snapshot chunks share a tick: clearing before the NEXT update must not
    // erase the road upload belonging to the chunk just consumed.
    game.update(makeEmptyGu(5000));
    uploadFrameData(target, game.frameData());
    expect(uploads).toHaveLength(1);
  });
});
