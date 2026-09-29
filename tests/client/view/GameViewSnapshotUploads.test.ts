import { expect, it, vi } from "vitest";
import {
  uploadFrameData,
  type FrameUploadTarget,
} from "../../../src/client/render/frame/Upload";
import { UnitType } from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import {
  makeEmptyGu,
  makeGameView,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../../util/viewStubs";

it("ingests snapshot parts without repeated entity uploads, then uploads complete structures and units", () => {
  const game = makeGameView();
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const view = new Proxy(
    {},
    {
      get: (_, key: string) => {
        if (!calls.has(key)) calls.set(key, vi.fn());
        return calls.get(key);
      },
    },
  ) as FrameUploadTarget;
  const begin = makeEmptyGu(100);
  begin.snapshotPhase = "begin";
  begin.updates[GameUpdateType.Player] = [makePlayerUpdate()];
  game.update(begin);
  uploadFrameData(view, game.frameData());
  const part = makeEmptyGu(100);
  part.snapshotPhase = "part";
  part.updates[GameUpdateType.Unit] = [
    makeUnitUpdate({ id: 8, unitType: UnitType.City }),
  ];
  game.update(part);
  uploadFrameData(view, game.frameData());
  for (let i = 0; i < 100; i++) {
    const empty = makeEmptyGu(100);
    empty.snapshotPhase = "part";
    game.update(empty);
    uploadFrameData(view, game.frameData());
  }
  expect(calls.get("updateUnits")).toBeUndefined();
  expect(calls.get("updateStructures")).toBeUndefined();
  expect(game.frameData().structuresDirty).toBe(true);
  const end = makeEmptyGu(100);
  end.snapshotPhase = "end";
  game.update(end);
  uploadFrameData(view, game.frameData());
  expect(calls.get("updateUnits")).toHaveBeenCalledOnce();
  expect(calls.get("updateStructures")).toHaveBeenCalledOnce();
  expect(game.frameData().structures.has(8)).toBe(true);
  game.update(makeEmptyGu(101));
  uploadFrameData(view, game.frameData());
  expect(calls.get("updateUnits")).toHaveBeenCalledTimes(2);
  expect(calls.get("updateStructures")).toHaveBeenCalledOnce();
});
