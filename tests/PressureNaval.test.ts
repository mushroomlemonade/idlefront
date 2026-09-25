import { PseudoRandom } from "../src/core/PseudoRandom";
import { navalPacingScale } from "../src/core/execution/NavalPacing";
import { TransportShipExecution } from "../src/core/execution/TransportShipExecution";
import type { NationEmojiBehavior } from "../src/core/execution/nation/NationEmojiBehavior";
import { NationWarshipBehavior } from "../src/core/execution/nation/NationWarshipBehavior";
import { AiAttackBehavior } from "../src/core/execution/utils/AiAttackBehavior";
import {
  PlayerType,
  UnitType,
  type Game,
  type Player,
} from "../src/core/game/Game";
import { canBuildTransportShip } from "../src/core/game/TransportShipUtils";
vi.mock("../src/core/game/TransportShipUtils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  canBuildTransportShip: vi.fn(() => 10),
}));

function scenario() {
  vi.mocked(canBuildTransportShip).mockClear();
  vi.mocked(canBuildTransportShip).mockReturnValue(10);
  let ticks = 2000;
  const player = {
    smallID: () => 1,
    troops: () => 100000,
    numTilesOwned: () => 100,
    incomingAttacks: () => [],
    unitCount: () => 0,
    units: () => [],
    isFriendly: () => false,
    canAttackPlayer: () => true,
    isPlayer: () => true,
    type: () => PlayerType.Nation,
  } as unknown as Player;
  const enemies = Array.from(
    { length: 20 },
    (_, id) =>
      ({
        isAlive: () => true,
        isPlayer: () => true,
        type: () => PlayerType.Nation,
        troops: () => 50000,
        units: () => [{ tile: () => 100 + id }],
      }) as unknown as Player,
  );
  const config = { continuousPressure: "v1", pressureGraceSeconds: 0 };
  const game = {
    ticks: () => ticks,
    elapsedGameSeconds: () => 200,
    inSpawnPhase: () => false,
    players: () => enemies,
    owner: (tile: number) => enemies[tile - 100],
    addExecution: vi.fn(),
    width: () => 10,
    height: () => 10,
    ref: () => 0,
    hasOwner: () => true,
    config: () => ({
      gameConfig: () => config,
      isUnitDisabled: () => false,
      boatMaxNumber: () => 10,
    }),
  } as unknown as Game;
  const behavior = new AiAttackBehavior(
    new PseudoRandom(42),
    game,
    player,
    0.5,
    0.3,
    0.2,
  );
  return {
    game,
    player,
    behavior,
    config,
    advance: () => {
      ticks += 500;
    },
  };
}

test("pressure AI launches a native overseas transport and respects cooldown", () => {
  const { behavior, game } = scenario();
  behavior.maybeAttack();
  expect(game.addExecution).toHaveBeenCalledWith(
    expect.any(TransportShipExecution),
  );
  behavior.maybeAttack();
  expect(game.addExecution).toHaveBeenCalledTimes(1);
});

test("unreachable coasts consume at most two queries per decision", () => {
  const { behavior, game } = scenario();
  vi.mocked(canBuildTransportShip).mockReturnValue(false);
  behavior.maybeAttack();
  expect(canBuildTransportShip).toHaveBeenCalledTimes(2);
  expect(game.addExecution).not.toHaveBeenCalled();
});

test("an invasion gets a follow-up wave, then switches away after no progress", () => {
  const { behavior, advance } = scenario();
  behavior.maybeAttack();
  const first = vi.mocked(canBuildTransportShip).mock.calls[0][2];
  advance();
  behavior.maybeAttack();
  expect(vi.mocked(canBuildTransportShip).mock.calls[1][2]).toBe(first);
  advance();
  behavior.maybeAttack();
  expect(vi.mocked(canBuildTransportShip).mock.calls[2][2]).not.toBe(first);
});

test("prefers a weak coastal target within its bounded sample", () => {
  const { behavior, game } = scenario();
  vi.spyOn(game.players()[4], "troops").mockReturnValue(1);
  behavior.maybeAttack();
  expect(vi.mocked(canBuildTransportShip).mock.calls[0][2]).toBe(104);
});

test("does not abandon a three-wave campaign while transports are still crossing", () => {
  const { behavior, player, advance, game } = scenario();
  behavior.maybeAttack();
  const tile = vi.mocked(canBuildTransportShip).mock.calls[0][2];
  vi.spyOn(player, "units").mockReturnValue([
    {
      isActive: () => true,
      targetTile: () => tile,
      transportShipState: () => ({ isRetreating: false }),
    } as never,
  ]);
  for (let i = 0; i < 5; i++) {
    advance();
    behavior.maybeAttack();
  }
  expect(game.addExecution).toHaveBeenCalledTimes(3);
  expect(
    vi
      .mocked(canBuildTransportShip)
      .mock.calls.every((call) => call[2] === tile),
  ).toBe(true);
});

test("naval preparation cadence follows mobilisation pace", () => {
  const { game, config } = scenario();
  expect(navalPacingScale(game)).toBe(1);
  Object.assign(config, {
    pressurePacing: { mobilisationHalfLifeSeconds: 10 },
  });
  expect(navalPacingScale(game)).toBe(2);
  Object.assign(config, {
    pressurePacing: { mobilisationHalfLifeSeconds: 3600 },
  });
  expect(navalPacingScale(game)).toBe(720);
});

test("assigns at most two existing warships to escort a live invasion", () => {
  const { game, player } = scenario();
  const ships = Array.from({ length: 3 }, () => ({
    isActive: () => true,
    isUnderConstruction: () => false,
    updateWarshipState: vi.fn(),
  }));
  vi.spyOn(player, "units").mockImplementation((type) => {
    if (type === UnitType.Warship) return ships as never;
    if (type === UnitType.TransportShip)
      return [
        {
          isActive: () => true,
          transportShipState: () => ({ isRetreating: false }),
          tile: () => 99,
          targetTile: () => 104,
        },
      ] as never;
    return [];
  });
  Object.assign(game, { isWater: () => true });
  const navy = new NationWarshipBehavior(
    new PseudoRandom(42),
    game,
    player,
    {} as NationEmojiBehavior,
  );
  navy.maybeSpawnWarship();
  expect(ships[0].updateWarshipState).toHaveBeenCalledWith({ patrolTile: 99 });
  expect(ships[1].updateWarshipState).toHaveBeenCalledWith({ patrolTile: 99 });
  expect(ships[2].updateWarshipState).not.toHaveBeenCalled();
});

test.each(["allied", "grace", "fleet limit"])(
  "no invasion when %s",
  (reason) => {
    const { behavior, player, config, game } = scenario();
    if (reason === "allied")
      vi.spyOn(player, "isFriendly").mockReturnValue(true);
    if (reason === "grace") config.pressureGraceSeconds = 1000;
    if (reason === "fleet limit")
      vi.spyOn(player, "unitCount").mockImplementation((type) =>
        type === UnitType.TransportShip ? 3 : 0,
      );
    behavior.maybeAttack();
    expect(canBuildTransportShip).not.toHaveBeenCalled();
    expect(game.addExecution).not.toHaveBeenCalled();
  },
);
