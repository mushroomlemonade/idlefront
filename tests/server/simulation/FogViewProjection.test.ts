import { expect, it } from "vitest";
import { configureFleet } from "../../../src/core/execution/FleetAutomation";
import {
  PlayerInfo,
  PlayerType,
  TrainType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import {
  packMotionPlans,
  unpackMotionPlans,
} from "../../../src/core/game/MotionPlans";
import { PlayerImpl } from "../../../src/core/game/PlayerImpl";
import { FogViewProjection } from "../../../src/server/simulation/FogViewProjection";
import { GameFog } from "../../../src/server/simulation/GameFog";
import { emptyView } from "../../../src/server/simulation/ViewSnapshot";
import { setup } from "../../util/Setup";

it("redacts hidden activity, reveals units without needing a fresh engine diff, and forgets them on sight loss", async () => {
  const template = await setup("ocean_and_land", {
    instantBuild: true,
    infiniteGold: true,
  });
  const terrain = new GameMapImpl(
    400,
    200,
    new Uint8Array(80000).fill(128),
    80000,
  );
  const game = createGame(
    [1, 2].map(
      (id) => new PlayerInfo(`p${id}`, PlayerType.Human, `seat${id}`, `p${id}`),
    ),
    [],
    terrain,
    terrain,
    template.config(),
  );
  const fog = new GameFog(game, "projection-test");
  const a = game.player("p1"),
    b = game.player("p2");
  a.conquer(game.ref(20, 20));
  a.setSpawnTile(game.ref(20, 20));
  b.conquer(game.ref(200, 100));
  b.setSpawnTile(game.ref(200, 100));
  const factory = b.buildUnit(UnitType.Factory, game.ref(200, 100), {});
  fog.advance();
  const project = new FogViewProjection(game, fog.forClient("seat1"));
  const source = emptyView(1);
  for (const player of [a, b])
    configureFleet(game, player, {
      enabled: true,
      target: 2,
      reserve: 1000,
      ports: [],
      order: "defend",
    });
  source.updates[GameUpdateType.Player] = game
    .allPlayers()
    .map((p) => (p as PlayerImpl).toFullUpdate());
  source.updates[GameUpdateType.Unit] = [factory.toUpdate()];
  source.packedPlayerUpdates = new Float64Array([
    a.smallID(),
    1,
    50,
    100,
    b.smallID(),
    1,
    99999,
    88888,
  ]);
  source.packedTileUpdates = new Uint32Array([game.ref(200, 100), b.smallID()]);
  source.packedMotionPlans = packMotionPlans([
    {
      kind: "grid",
      unitId: factory.id(),
      planId: 1,
      startTick: 1,
      ticksPerStep: 1,
      path: [game.ref(200, 100), game.ref(201, 100)],
    },
  ]);
  const hidden = project.project(source);
  expect(
    hidden.updates[GameUpdateType.Player].find((p) => p.id === a.id())?.fleet
      ?.enabled,
  ).toBe(true);
  expect(
    hidden.updates[GameUpdateType.Player].find((p) => p.id === b.id())?.fleet,
  ).toBeUndefined();
  expect(hidden.updates[GameUpdateType.Unit]).toHaveLength(0);
  expect(hidden.packedPlayerUpdates).toEqual(
    new Float64Array([a.smallID(), 1, 50, 100]),
  );
  expect(unpackMotionPlans(hidden.packedMotionPlans!)).toHaveLength(0);
  expect([...hidden.fog!.hiddenPlayers]).toContain(b.smallID());
  const train = a.buildUnit(UnitType.Train, game.ref(190, 100), {
    trainType: TrainType.Engine,
  });
  fog.advance();
  const revealed = project.project(emptyView(2));
  expect(
    revealed.updates[GameUpdateType.Unit].some((u) => u.id === factory.id()),
  ).toBe(true);
  expect([...revealed.fog!.hiddenPlayers]).not.toContain(b.smallID());
  train.move(game.ref(250, 100));
  fog.advance();
  const lost = project.project(emptyView(3));
  expect([...lost.fog!.forgottenUnits]).toContain(factory.id());
  expect(
    lost.updates[GameUpdateType.Unit].some((u) => u.id === factory.id()),
  ).toBe(false);
  expect(
    lost.updates[GameUpdateType.Player].find((p) => p.id === b.id())?.troops,
  ).toBe(0);
  fog.dispose();
});
