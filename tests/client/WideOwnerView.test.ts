import { afterEach, expect, it } from "vitest";
import { buildRelationMatrix } from "../../src/client/render/frame/derive/RelationMatrix";
import {
  configureOwnerCapacity,
  ownerPaletteShape,
} from "../../src/client/render/gl/utils/ColorUtils";
import { foldedTextureShape } from "../../src/client/render/gl/utils/OwnerTextureLayout";
import { playerTextureCapacity } from "../../src/client/render/PlayerTextureCapacity";
import type { PlayerState } from "../../src/client/render/types";
import { GameView } from "../../src/client/view/GameView";
import { GameMapImpl } from "../../src/core/game/GameMap";
import {
  packTileState,
  stateWithOwner,
} from "../../src/core/game/OwnerIdCodec";
import {
  SharedPlanningWorld,
  sharedPlanningReader,
} from "../../src/server/simulation/SharedPlanningWorld";
import {
  makeEmptyGu,
  stubConfig,
  stubTerrainMap,
  stubWorker,
} from "../util/viewStubs";

afterEach(() => configureOwnerCapacity(false));

it("keeps high owner bits across snapshots, terrain changes and subsequent live updates", () => {
  const terrain = stubTerrainMap();
  const map = new GameMapImpl(
    10,
    10,
    new Uint8Array(100).fill(128),
    100,
    undefined,
    true,
  );
  terrain.gameMap = map;
  const game = new GameView(
    stubWorker(),
    stubConfig(),
    terrain,
    undefined,
    "test",
    null,
    "wide",
    [],
  );
  const snapshot = makeEmptyGu(1);
  snapshot.packedTileRuns = new Uint32Array([
    1,
    3,
    stateWithOwner(0x6000, 16000, true),
  ]);
  game.update(snapshot);
  expect(map.ownerID(1)).toBe(16000);
  expect(map.hasFallout(1)).toBe(true);
  const changed = makeEmptyGu(2);
  changed.packedTerrainUpdates = new Uint32Array([1, 0]);
  changed.packedTileUpdates = new Uint32Array([
    2,
    packTileState(stateWithOwner(0, 65535, true), 128),
  ]);
  game.update(changed);
  expect(map.ownerID(1)).toBe(16000);
  expect(map.terrainByte(1)).toBe(0);
  expect(map.ownerID(2)).toBe(65535);
});

it("shares high owner IDs with planning workers without truncation", () => {
  const map = new GameMapImpl(
    4,
    1,
    new Uint8Array(4).fill(128),
    4,
    undefined,
    true,
  );
  const shared = new SharedPlanningWorld(map);
  const reader = sharedPlanningReader(shared.data);
  map.setOwnerID(1, 16000);
  const epoch = shared.beginRead();
  reader.begin(epoch);
  expect(reader.map.ownerID(1)).toBe(16000);
  expect(shared.endRead(epoch)).toBe(true);
  shared.dispose();
});

it("bounds all wide textures to WebGL2 minimum texture limits with unchanged byte order", () => {
  configureOwnerCapacity(true);
  expect(playerTextureCapacity(16000, 40, true, true)).toBe(32768);
  for (const rows of [2, 32]) {
    const shape = ownerPaletteShape(rows);
    expect(shape.width).toBeLessThanOrEqual(4096);
    expect(shape.height).toBeLessThanOrEqual(4096);
    expect(shape.width * shape.height).toBe(65536 * rows);
  }
  for (const [width, height] of [
    [9, 65536],
    [32, 131072],
  ]) {
    const shape = foldedTextureShape(width, height);
    expect(shape.width * shape.height).toBe(width * height);
    expect(shape.height).toBeLessThanOrEqual(4096);
    expect(shape.width).toBeLessThanOrEqual(4096);
  }
});

it("uses a compact high-ID diplomacy row with embargo precedence", () => {
  const players = new Map<number, PlayerState>([
    [
      1,
      { smallID: 1, allies: [16000, 16001], embargoes: [16001] } as PlayerState,
    ],
    [
      16000,
      { smallID: 16000, allies: [], embargoes: [] } as unknown as PlayerState,
    ],
    [
      16001,
      { smallID: 16001, allies: [], embargoes: [] } as unknown as PlayerState,
    ],
  ]);
  const result = buildRelationMatrix(players, undefined, 1);
  expect(result.matrix.byteLength).toBe(65536);
  expect(result.matrix[16000]).toBe(1);
  expect(result.matrix[16001]).toBe(2);
});
