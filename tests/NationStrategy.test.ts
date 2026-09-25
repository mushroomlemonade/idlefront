import { AttackExecution } from "../src/core/execution/AttackExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { applyContinuousPressure } from "../src/core/execution/ContinuousPressure";
import { MirvExecution } from "../src/core/execution/MIRVExecution";
import {
  noteNationStrike,
  significantDiplomaticPush,
} from "../src/core/execution/nation/NationOpportunity";
import {
  conquestValue,
  nationStrategy,
  usesNationStrategy,
} from "../src/core/execution/nation/NationStrategy";
import { NationExecution } from "../src/core/execution/NationExecution";
import { NukeExecution } from "../src/core/execution/NukeExecution";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { PlayerType, UnitType } from "../src/core/game/Game";
import { createGame } from "../src/core/game/GameImpl";
import { GameMapImpl } from "../src/core/game/GameMap";
import {
  pressurePopulation,
  pressureView,
} from "../src/core/game/PressurePopulation";
import { createNavalScenario } from "./util/NavalScenario";
import { playerInfo, setup } from "./util/Setup";

async function landFixture() {
  const game = await setup(
    "ocean_and_land",
    {
      continuousPressure: "v1",
      nationStrategy: "v1",
      pressureGraceSeconds: 0,
    },
    [playerInfo("a", PlayerType.Nation), playerInfo("b", PlayerType.Nation)],
  );
  const a = game.player("a"),
    b = game.player("b");
  a.conquer(game.ref(0, 0));
  b.conquer(game.ref(0, 1));
  a.setSpawnTile(game.ref(0, 0));
  b.setSpawnTile(game.ref(0, 1));
  a.setTroops(10000);
  b.setTroops(2000);
  pressurePopulation(game, a);
  return { game, a, b, strategy: nationStrategy(game, a) };
}

test("v2 recognises extreme army depletion beyond the old strength cap", async () => {
  const { game, b, strategy } = await landFixture();
  b.setTroops(2000);
  const oldNormal = strategy["score"](b, 0);
  b.setTroops(200);
  expect(strategy["score"](b, 0)).toBe(oldNormal);
  game.config().gameConfig().nationStrategy = "v2";
  const vulnerable = strategy["score"](b, 0);
  b.setTroops(2000);
  expect(vulnerable).toBeGreaterThan(strategy["score"](b, 0) * 2);
});

test("v2 reinforces a dwindling wilderness front, v1 preserves its old behavior", async () => {
  for (const version of ["v1", "v2"] as const) {
    const { game, a, strategy } = await landFixture();
    game.config().gameConfig().nationStrategy = version;
    a.createAttack(game.terraNullius(), 10, null, new Set());
    const add = vi.spyOn(game, "addExecution");
    strategy.tick();
    expect(
      add.mock.calls
        .flat()
        .some((e) => e instanceof AttackExecution && e.targetID() === null),
    ).toBe(version === "v2");
  }
});

test("v2 turns a nuclear strike into a prioritised legal conquest, not an alliance bypass", async () => {
  const { game, a, b, strategy } = await landFixture();
  game.config().gameConfig().nationStrategy = "v2";
  const before = strategy["score"](b, 0);
  noteNationStrike(game, a, b);
  expect(strategy["score"](b, 0)).toBe(before * 4);
  strategy.tick();
  expect(strategy.plan.target).toBe(b.smallID());
  expect(strategy.plan.kind).toBe("conquer");
  vi.spyOn(a, "isFriendly").mockReturnValue(true);
  strategy["strikeTarget"] = null;
  noteNationStrike(game, a, b);
  expect(strategy["strikeTarget"]).toBeNull();
});

test.each([UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV] as const)(
  "paid native %s launch notifies the v2 conquest planner",
  async (type) => {
    const game = await setup(
      "big_plains",
      {
        continuousPressure: "v1",
        nationStrategy: "v2",
        pressureGraceSeconds: 0,
        instantBuild: true,
      },
      [playerInfo("a", PlayerType.Nation), playerInfo("b", PlayerType.Human)],
    );
    const a = game.player("a"),
      b = game.player("b");
    for (let y = 10; y < 40; y++)
      for (let x = 10; x < 40; x++) a.conquer(game.ref(x, y));
    for (let y = 60; y < 90; y++)
      for (let x = 60; x < 90; x++) b.conquer(game.ref(x, y));
    a.setSpawnTile(game.ref(20, 20));
    b.setSpawnTile(game.ref(75, 75));
    a.addGold(1_000_000_000n);
    a.buildUnit(UnitType.MissileSilo, game.ref(20, 20), {});
    a.setTroops(100000);
    b.setTroops(10000);
    const observe = vi.spyOn(nationStrategy(game, a), "noteStrike");
    const gold = a.gold();
    game.addExecution(
      type === UnitType.MIRV
        ? new MirvExecution(a, game.ref(75, 75))
        : new NukeExecution(type, a, game.ref(75, 75)),
    );
    for (let i = 0; i < 3; i++) game.executeNextTick();
    expect(observe).toHaveBeenCalledWith(b);
    expect(a.unitCount(type)).toBe(1);
    expect(a.gold()).toBeLessThan(gold);
  },
);

test("v2 small pressure does not embargo, reject diplomacy or damage relations; substantial pushes do", async () => {
  const { game, a, b } = await landFixture();
  game.config().gameConfig().nationStrategy = "v2";
  const relation = vi.spyOn(b, "updateRelation");
  const embargo = vi.spyOn(b, "addEmbargo");
  expect(significantDiplomaticPush(game, b, 100)).toBe(false);
  new AttackExecution(100, a, b.id()).init(game, 0);
  expect(relation).not.toHaveBeenCalled();
  expect(embargo).not.toHaveBeenCalled();
  new AttackExecution(1000, a, b.id()).init(game, 0);
  expect(relation).toHaveBeenCalled();
  expect(embargo).toHaveBeenCalled();
});

test("values developed, vulnerable, nearby and persistent targets", () => {
  const base = conquestValue(1000, 0, 5000, 10000, 0, false, false);
  expect(conquestValue(1000, 10, 5000, 10000, 0, false, false)).toBeGreaterThan(
    base,
  );
  expect(conquestValue(1000, 0, 20000, 10000, 0, false, false)).toBeLessThan(
    base,
  );
  expect(conquestValue(1000, 0, 5000, 10000, 500, false, false)).toBeLessThan(
    base,
  );
  expect(conquestValue(1000, 0, 5000, 10000, 0, true, true)).toBeGreaterThan(
    base,
  );
});

test("all nations in a versioned game opt in, not humans, tribes, fog or old saves", async () => {
  const { game, a, b } = await landFixture();
  expect(usesNationStrategy(game, a)).toBe(true);
  expect(usesNationStrategy(game, b)).toBe(true);
  vi.spyOn(a, "type").mockReturnValue(PlayerType.Human);
  expect(usesNationStrategy(game, a)).toBe(false);
  vi.mocked(a.type).mockReturnValue(PlayerType.Bot);
  expect(usesNationStrategy(game, a)).toBe(false);
  game.config().gameConfig().fogOfWar = "v0.2";
  expect(usesNationStrategy(game, b)).toBe(false);
  delete game.config().gameConfig().fogOfWar;
  delete game.config().gameConfig().nationStrategy;
  expect(usesNationStrategy(game, b)).toBe(false);
});

test("launches a native land campaign, mobilises normally, and never duplicates the same tick", async () => {
  const { game, a, b, strategy } = await landFixture();
  const add = vi.spyOn(game, "addExecution");
  strategy.tick();
  strategy.tick();
  const orders = add.mock.calls
    .flat()
    .filter((e) => e instanceof AttackExecution && e.targetID() === b.id());
  expect(orders).toHaveLength(1);
  expect(strategy.plan.kind).toBe("conquer");
  expect(pressureView(a)?.target).toBe(0.75);
  expect(a.troops()).toBe(10000); // queued executor, not a second resource writer
  const count = add.mock.calls.length;
  applyContinuousPressure(game, a, a.smallID() % 10);
  expect(add.mock.calls.length).toBe(count);
});

test("never targets protected or allied nations", async () => {
  for (const reason of ["grace", "ally"]) {
    const { game, a, b, strategy } = await landFixture();
    if (reason === "grace")
      game.config().gameConfig().pressureGraceSeconds = 180;
    else vi.spyOn(a, "isFriendly").mockReturnValue(true);
    const add = vi.spyOn(game, "addExecution");
    strategy.tick();
    expect(
      add.mock.calls
        .flat()
        .some((e) => e instanceof AttackExecution && e.targetID() === b.id()),
    ).toBe(false);
  }
});

test("defends rather than draining reserves during a major attack", async () => {
  const { game, a, b, strategy } = await landFixture();
  b.createAttack(a, 8000, null, new Set());
  const add = vi.spyOn(game, "addExecution");
  strategy.tick();
  expect(strategy.plan.kind).toBe("defend");
  expect(pressureView(a)?.target).toBe(0.8);
  expect(add.mock.calls.flat().some((e) => e instanceof AttackExecution)).toBe(
    false,
  );
});

test("does not renew permanent peace with the final opponent", async () => {
  const { b, strategy } = await landFixture();
  expect(strategy.usefulAlly(b)).toBe(false);
});

function nativeInvasion(
  strategic = true,
  coastalDefense = false,
  version: "v1" | "v2" = "v1",
) {
  const { game, attacker, defender } = createNavalScenario();
  if (strategic) game.config().gameConfig().nationStrategy = version;
  if (version === "v2") game.config().gameConfig().fleetAutomation = "v26.3";
  const strategy = nationStrategy(game, attacker);
  game.addExecution(
    new NationExecution("strategy-test", {
      playerInfo: attacker.info(),
      spawnCell: undefined,
    }),
  );
  let landed = false,
    ships = 0,
    ticks = 0;
  const durations: number[] = [];
  for (let i = 0; i < 4000 && defender.isAlive(); i++) {
    if (i === 130 && coastalDefense)
      game.addExecution(
        new ConstructionExecution(
          defender,
          UnitType.Warship,
          game.ref(230, 80),
        ),
      );
    const start = performance.now();
    game.executeNextTick();
    durations.push(performance.now() - start);
    ticks++;
    landed ||= attacker.numTilesOwned() > 5600;
    ships = Math.max(ships, attacker.unitCount(UnitType.Warship));
    game.drainPackedTileUpdates();
    game.drainPackedPlayerUpdates();
  }
  return {
    landed,
    ships,
    alive: defender.isAlive(),
    land: attacker.numTilesOwned(),
    gold: attacker.gold().toString(),
    plan: { ...strategy.plan },
    ticks,
    p95: durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)],
  };
}

test("full native nation execution invades, reinforces, develops, and eliminates a vulnerable island", () => {
  const result = nativeInvasion();
  expect(result.landed).toBe(true);
  expect(result.ships).toBeGreaterThan(0);
  expect(result.alive).toBe(false);
  expect(result.land).toBe(8800);
}, 30000);

test("native campaign replay is deterministic", () => {
  const first = nativeInvasion(),
    second = nativeInvasion();
  expect({ ...first, p95: 0 }).toEqual({ ...second, p95: 0 });
}, 30000);

test("v2 native invasion with fleet automation is deterministic and takes the defended island", () => {
  const first = nativeInvasion(true, true, "v2");
  const second = nativeInvasion(true, true, "v2");
  expect(first.landed).toBe(true);
  expect(first.alive).toBe(false);
  expect({ ...first, p95: 0 }).toEqual({ ...second, p95: 0 });
  console.log("v2 defended island fixture", JSON.stringify(first));
}, 30000);

test("records bounded old/new native invasion results including a defended coast", () => {
  const results = [];
  for (const defended of [false, true]) {
    for (const strategic of [false, true]) {
      const result = nativeInvasion(strategic, defended);
      results.push({
        strategic,
        defended,
        eliminated: !result.alive,
        ticks: result.ticks,
        ships: result.ships,
        p95Ms: Number(result.p95.toFixed(3)),
      });
      if (strategic) expect(result.landed).toBe(true);
    }
  }
  console.log("bounded native comparison", JSON.stringify(results));
}, 30000);

test("fleet builds use normal construction and cannot spend nonexistent gold", () => {
  const { game, attacker } = createNavalScenario();
  game.config().gameConfig().nationStrategy = "v1";
  for (let i = 0; i < 130; i++) game.executeNextTick();
  attacker.removeGold(attacker.gold());
  const add = vi.spyOn(game, "addExecution");
  nationStrategy(game, attacker).tick();
  expect(
    add.mock.calls.flat().some((e) => e instanceof ConstructionExecution),
  ).toBe(false);
  expect(attacker.gold()).toBe(0n);
});

test.each(["v1", "v2"] as const)(
  "four full nations expand, invest and fight on a continental board (%s)",
  (version) => {
    const { game: source } = createNavalScenario();
    source.config().gameConfig().nationStrategy = version;
    source.config().gameConfig().disableAlliances = true;
    const width = 160,
      height = 160;
    const makeMap = () =>
      new GameMapImpl(
        width,
        height,
        new Uint8Array(width * height).fill(128),
        width * height,
      );
    const infos = [0, 1, 2, 3].map((i) =>
      playerInfo(`continental-${i}`, PlayerType.Nation),
    );
    const nations = infos.map((playerInfo) => ({
      playerInfo,
      spawnCell: undefined,
    }));
    const game = createGame([], nations, makeMap(), makeMap(), source.config());
    const players = infos.map((info) => game.addPlayer(info));
    for (let i = 0; i < players.length; i++) {
      const p = players[i],
        x0 = (i % 2) * 80 + 10,
        y0 = Math.floor(i / 2) * 80 + 10;
      for (let y = y0; y < y0 + 60; y++)
        for (let x = x0; x < x0 + 60; x++) p.conquer(game.ref(x, y));
      p.setSpawnTile(game.ref(x0 + 30, y0 + 30));
      p.setTroops(30000 + i * 5000);
      p.addGold(500000n);
      game.addExecution(
        new PlayerExecution(p),
        new NationExecution("continental", nations[i]),
      );
    }
    game.endSpawnPhase();
    let campaigns = 0;
    for (let i = 0; i < 2500; i++) {
      game.executeNextTick();
      if (i % 50 === 0)
        campaigns += players.filter(
          (p) => nationStrategy(game, p).plan.kind === "conquer",
        ).length;
      game.drainPackedTileUpdates();
      game.drainPackedPlayerUpdates();
    }
    expect(campaigns).toBeGreaterThan(0);
    expect(
      players.reduce((n, p) => n + p.unitCount(UnitType.City), 0),
    ).toBeGreaterThan(0);
    expect(Math.max(...players.map((p) => p.numTilesOwned()))).toBeGreaterThan(
      5000,
    );
    expect(players.every((p) => p.gold() >= 0n && p.troops() >= 0)).toBe(true);
  },
  30000,
);
