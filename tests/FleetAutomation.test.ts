import { beforeEach, describe, expect, it, vi } from "vitest";
import { Executor } from "../src/core/execution/ExecutionManager";
import {
  configureFleet,
  configureNationFleet,
  fleetHash,
  fleetView,
  updateFleet,
} from "../src/core/execution/FleetAutomation";
import { MoveWarshipExecution } from "../src/core/execution/MoveWarshipExecution";
import { type FleetOrders } from "../src/core/FleetOrders";
import {
  type Game,
  type Player,
  type Unit,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import {
  notePressureActivity,
  pressurePopulation,
  pressureView,
  setExplicitIdle,
  updatePressurePopulation,
} from "../src/core/game/PressurePopulation";
import { IntentSchema } from "../src/core/Schemas";
import { playerInfo, setup } from "./util/Setup";

let game: Game, player: Player, other: Player, port: Unit;
let orders: FleetOrders;
beforeEach(async () => {
  game = await setup(
    "half_land_half_ocean",
    {
      continuousPressure: "v1",
      pressurePacing: {
        populationDoublingSeconds: 600,
        mobilisationHalfLifeSeconds: 5,
      },
    },
    [
      playerInfo("alpha", PlayerType.Human),
      playerInfo("bravo", PlayerType.Human),
    ],
  );
  player = game.player("alpha");
  other = game.player("bravo");
  player.conquer(game.ref(7, 10));
  other.conquer(game.ref(7, 15));
  player.addGold(10_000_000n);
  port = player.buildUnit(UnitType.Port, game.ref(7, 10), {});
  orders = {
    enabled: true,
    target: 2,
    reserve: 100_000,
    ports: [port.id()],
    order: "defend",
  };
});
function ticks(n: number) {
  for (let i = 0; i < n; i++) {
    updateFleet(game, player);
    game.executeNextTick();
  }
}

describe("authoritative fleet automation", () => {
  it("lets v2 nations replenish through native purchases while client fleet commands stay human-only", () => {
    vi.spyOn(player, "type").mockReturnValue(PlayerType.Nation);
    game.config().gameConfig().nationStrategy = "v2";
    configureFleet(game, player, orders);
    expect(fleetView(player)).toBeUndefined();
    configureNationFleet(game, player, orders);
    const revision = fleetView(player)!.revision;
    configureNationFleet(game, player, orders);
    expect(fleetView(player)!.revision).toBe(revision);
    const gold = player.gold();
    ticks(150);
    expect(player.unitCount(UnitType.Warship)).toBe(2);
    expect(player.gold()).toBeLessThan(gold);
    expect(player.gold()).toBeGreaterThanOrEqual(BigInt(orders.reserve));
  });

  it("does not enable nation replenishment in legacy games or for humans through the AI entry point", () => {
    game.config().gameConfig().nationStrategy = "v2";
    configureNationFleet(game, player, orders);
    expect(fleetView(player)).toBeUndefined();
    vi.spyOn(player, "type").mockReturnValue(PlayerType.Nation);
    game.config().gameConfig().nationStrategy = "v1";
    configureNationFleet(game, player, orders);
    expect(fleetView(player)).toBeUndefined();
  });
  it("uses current owned ports without selections and zero target spends nothing", () => {
    configureFleet(game, player, {
      ...orders,
      automaticPorts: true,
      ports: [],
      target: 0,
    });
    const gold = player.gold();
    ticks(70);
    expect(player.unitCount(UnitType.Warship)).toBe(0);
    expect(player.gold()).toBe(gold);
    configureFleet(game, player, {
      ...orders,
      automaticPorts: true,
      ports: [],
      target: 1,
    });
    ticks(70);
    expect(player.unitCount(UnitType.Warship)).toBe(1);
  });
  it("uses native costs, counts queued ships, caps the target and replaces losses", () => {
    player.markDisconnected(true);
    configureFleet(game, player, orders);
    const before = player.gold();
    const cost = game.unitInfo(UnitType.Warship).cost(game, player);
    ticks(5);
    expect(player.unitCount(UnitType.Warship)).toBe(1);
    expect(player.gold()).toBe(before - cost);
    ticks(180);
    expect(player.unitCount(UnitType.Warship)).toBe(2);
    player.units(UnitType.Warship)[0].delete();
    ticks(70);
    expect(player.unitCount(UnitType.Warship)).toBe(2);
  });
  it("rechecks reserve after intervening spending and avoids duplicate queued builds", () => {
    configureFleet(game, player, orders);
    game.executeNextTick();
    updateFleet(game, player);
    updateFleet(game, player);
    expect(fleetView(player)?.pending).toBe(1);
    player.removeGold(player.gold() - BigInt(orders.reserve));
    ticks(5);
    expect(player.unitCount(UnitType.Warship)).toBe(0);
    expect(player.gold()).toBe(BigInt(orders.reserve));
    ticks(60);
    expect(fleetView(player)?.status).toBe("reserve reached");
  });
  it("rejects another player's ports and unknown client commands", () => {
    const foreign = other.buildUnit(UnitType.Port, game.ref(7, 15), {});
    configureFleet(game, player, { ...orders, ports: [foreign.id()] });
    expect(fleetView(player)).toBeUndefined();
    const executor = new Executor(game, "test", undefined);
    executor
      .createExec({ type: "fleet_orders", orders, clientID: "missing" })
      .init(game, 0);
    expect(fleetView(player)).toBeUndefined();
  });
  it("cancels queued construction after port capture or automation disable", () => {
    configureFleet(game, player, orders);
    game.executeNextTick();
    updateFleet(game, player);
    other.captureUnit(port);
    ticks(6);
    expect(player.unitCount(UnitType.Warship)).toBe(0);
    expect(other.unitCount(UnitType.Warship)).toBe(0);
  });
  it("cancels a pending purchase when settings are replaced", () => {
    configureFleet(game, player, orders);
    game.executeNextTick();
    updateFleet(game, player);
    configureFleet(game, player, { ...orders, enabled: false });
    ticks(6);
    expect(player.unitCount(UnitType.Warship)).toBe(0);
  });
  it("counts ships already under construction toward target", () => {
    const ship = player.buildUnit(UnitType.Warship, game.ref(8, 10), {
      patrolTile: game.ref(8, 10),
    });
    ship.setUnderConstruction(true);
    configureFleet(game, player, { ...orders, target: 1 });
    ticks(70);
    expect(player.unitCount(UnitType.Warship)).toBe(1);
  });
  it("manual patrol wins until fleet settings are explicitly reapplied", () => {
    configureFleet(game, player, { ...orders, target: 1 });
    ticks(6);
    const ship = player.units(UnitType.Warship)[0];
    const manualTile = game.ref(12, 15);
    new MoveWarshipExecution(player, [ship.id()], manualTile).init(
      game,
      game.ticks(),
    );
    ticks(70);
    expect(ship.warshipState().patrolTile).toBe(manualTile);
    configureFleet(game, player, { ...orders, target: 1 });
    ticks(6);
    expect(ship.warshipState().patrolTile).not.toBe(manualTile);
  });
  it("honours disabled units", () => {
    vi.spyOn(game.config(), "isUnitDisabled").mockReturnValue(true);
    configureFleet(game, player, orders);
    ticks(70);
    expect(player.unitCount(UnitType.Warship)).toBe(0);
    expect(fleetView(player)?.status).toBe("unit disabled");
  });
  it("bounds a twenty-ship offline run without exceeding its target", () => {
    player.addGold(100_000_000n); // Fixture funding covers the native escalating fleet cost.
    configureFleet(game, player, { ...orders, target: 20, reserve: 0 });
    player.markDisconnected(true);
    const times: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const started = performance.now();
      updateFleet(game, player);
      game.executeNextTick();
      times.push(performance.now() - started);
    }
    expect(player.unitCount(UnitType.Warship)).toBe(20);
    times.sort((a, b) => a - b);
    process.stdout.write(
      JSON.stringify({
        test: "fleet microfixture, one player, half_land_half_ocean",
        ticks: 1500,
        ships: 20,
        p99ms: times[Math.floor(times.length * 0.99)],
        maxMs: times[times.length - 1],
      }) + "\n",
    );
  });
  it("replays journaled orders deterministically with the same fleet, spending and automation hash", async () => {
    async function replay() {
      const replayGame = await setup("half_land_half_ocean", {}, [
        playerInfo("alpha", PlayerType.Human),
      ]);
      const replayPlayer = replayGame.player("alpha");
      replayPlayer.conquer(replayGame.ref(7, 10));
      replayPlayer.addGold(10_000_000n);
      const replayPort = replayPlayer.buildUnit(
        UnitType.Port,
        replayGame.ref(7, 10),
        {},
      );
      const journal = JSON.stringify({
        type: "fleet_orders",
        orders: { ...orders, ports: [replayPort.id()] },
        clientID: "alpha",
      });
      vi.spyOn(replayGame, "playerByClientID").mockReturnValue(replayPlayer);
      const parsed = JSON.parse(journal);
      new Executor(replayGame, "replay", undefined)
        .createExec(parsed)
        .init(replayGame, 0);
      for (let i = 0; i < 150; i++) {
        updateFleet(replayGame, replayPlayer);
        replayGame.executeNextTick();
      }
      return {
        gold: replayPlayer.gold(),
        ships: replayPlayer
          .units(UnitType.Warship)
          .map((s) => [s.id(), s.tile(), s.warshipState().patrolTile]),
        view: fleetView(replayPlayer),
        hash: fleetHash(replayPlayer),
      };
    }
    expect(await replay()).toEqual(await replay());
  });
  it("validates bounded journal settings and exposes authoritative updates", () => {
    expect(
      IntentSchema.safeParse({
        type: "fleet_orders",
        orders,
        clientID: "victim",
      }).success,
    ).toBe(false);
    expect(
      IntentSchema.safeParse({
        type: "fleet_orders",
        orders: { ...orders, target: 10001 },
      }).success,
    ).toBe(false);
    expect(
      IntentSchema.safeParse({
        type: "fleet_orders",
        orders: { ...orders, reserve: -1 },
      }).success,
    ).toBe(false);
    const restored = IntentSchema.parse(
      JSON.parse(JSON.stringify({ type: "fleet_orders", orders })),
    );
    expect(restored.type).toBe("fleet_orders");
    vi.spyOn(game, "playerByClientID").mockReturnValue(player);
    new Executor(game, "test", undefined)
      .createExec({ ...restored, clientID: "alpha" })
      .init(game, 0);
    const update = player.toUpdate();
    expect(update?.fleet?.ports).toEqual([port.id()]);
    expect(update?.fleet?.target).toBe(2);
  });
});

describe("explicit idle presence", () => {
  it("uses existing AFK mobilisation, grants no resources, and any manual device input resumes activity", () => {
    player.setTroops(1000);
    const state = pressurePopulation(game, player);
    const gold = player.gold(),
      troops = player.troops(),
      civilians = state.civilians;
    other.setTroops(9000);
    pressurePopulation(game, other).civilians = 1000;
    vi.spyOn(player, "incomingAttacks").mockReturnValue([
      { attacker: () => other },
    ] as never);
    setExplicitIdle(game, player, true);
    expect(player.gold()).toBe(gold);
    expect(player.troops()).toBe(troops);
    expect(state.civilians).toBe(civilians);
    updatePressurePopulation(game, player);
    expect(pressureView(player)?.automatic).toBe(true);
    expect(state.target).toBe(0.5);
    notePressureActivity(game, player);
    updatePressurePopulation(game, player);
    expect(pressureView(player)?.explicitIdle).toBe(false);
    expect(pressureView(player)?.automatic).toBe(false);
  });
});
