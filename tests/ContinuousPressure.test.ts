import { AttackExecution } from "../src/core/execution/AttackExecution";
import { applyContinuousPressure } from "../src/core/execution/ContinuousPressure";
import { Executor } from "../src/core/execution/ExecutionManager";
import { MirvExecution } from "../src/core/execution/MIRVExecution";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { AllianceExtensionExecution } from "../src/core/execution/alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { PlayerType, type Game, type Player } from "../src/core/game/Game";
import { diffPlayerUpdate } from "../src/core/game/GameUpdateUtils";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import {
  hasPressureGrace,
  hasProtectedAlliance,
} from "../src/core/game/PressureDiplomacy";
import {
  deployedTroops,
  pressureIncome,
  pressurePopulation,
  pressureView,
  setMobilisationTarget,
  updatePressurePopulation,
} from "../src/core/game/PressurePopulation";
import { playerInfo, setup } from "./util/Setup";

describe("native pressure rules", () => {
  let game: Game, a: Player, b: Player;
  beforeEach(async () => {
    game = await setup(
      "ocean_and_land",
      {
        continuousPressure: "v1",
        allianceProtectionMinutes: 5,
        pressurePacing: {
          populationDoublingSeconds: 600,
          mobilisationHalfLifeSeconds: 5,
        },
        donateTroops: true,
      },
      [playerInfo("a", PlayerType.Human), playerInfo("b", PlayerType.Human)],
    );
    a = game.player("a");
    b = game.player("b");
    a.conquer(game.ref(0, 0));
    b.conquer(game.ref(0, 1));
    a.setTroops(1000);
    b.setTroops(1000);
  });
  async function ally() {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    game.executeNextTick();
    expect(a.isAlliedWith(b)).toBe(true);
  }
  it("allows a bounded AI offensive on balanced fronts, but never into allies", () => {
    vi.spyOn(a, "type").mockReturnValue(PlayerType.Nation);
    const add = vi.spyOn(game, "addExecution");
    const tick = (Math.floor(a.smallID() / 10) % 30) * 10 + (a.smallID() % 10);
    applyContinuousPressure(game, a, tick);
    expect(
      add.mock.calls.some(
        ([execution]) =>
          execution instanceof AttackExecution &&
          execution.targetID() === b.id(),
      ),
    ).toBe(true);
    add.mockClear();
    vi.spyOn(a, "isFriendly").mockReturnValue(true);
    applyContinuousPressure(game, a, tick);
    // Wilderness pressure is still allowed; no attack may target the ally.
    expect(
      add.mock.calls.filter(
        ([execution]) =>
          execution instanceof AttackExecution &&
          execution.targetID() === b.id(),
      ).length,
    ).toBe(0);
  });
  it("always auto-defends when disconnected despite the active-play opt-out", () => {
    pressurePopulation(game, b).civilians = 100;
    setMobilisationTarget(game, a, 0.1, false);
    a.markDisconnected(true);
    b.createAttack(a, 200, null, new Set());
    b.removeTroops(200);
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(pressureView(a)!.autoDefenceEnabled).toBe(false);
    expect(pressureView(a)!.effectiveTarget).toBeGreaterThan(0.8);
    expect(pressureView(a)!.automatic).toBe(true);
    const exec = new Executor(game, "toggle-test", undefined).createExec({
      type: "mobilisation",
      clientID: a.clientID()!,
      target: 0.1,
      autoDefenceEnabled: true,
    });
    exec.init(game, game.ticks());
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(pressureView(a)!.autoDefenceEnabled).toBe(true);
    expect(pressureView(a)!.effectiveTarget).toBeGreaterThan(0.8);
    expect(pressureView(a)!.target).toBe(0.1);
  });
  it("auto-defends after inactivity even with active-play protection off", () => {
    pressurePopulation(game, b).civilians = 100;
    setMobilisationTarget(game, a, 0.1, false);
    b.createAttack(a, 200, null, new Set());
    b.removeTroops(200);
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(pressureView(a)!.automatic).toBe(false);
    pressurePopulation(game, a).lastManualTick = game.ticks() - 600;
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(pressureView(a)!.automatic).toBe(true);
    expect(pressureView(a)!.target).toBe(0.1);
  });
  it.each([PlayerType.Human, PlayerType.Bot, PlayerType.Nation])(
    "uses the unchanged native growth formula for %s at equal population",
    (type) => {
      vi.spyOn(a, "type").mockReturnValue(type);
      const state = pressurePopulation(game, a);
      game.config().gameConfig().pressurePacing!.populationGrowthMultiplier = 1;
      // Native comparator has exactly the same type, territory, and capacity.
      const total = state.civilians + a.troops();
      a.setTroops(total);
      const expected = game.config().troopIncreaseRate(a);
      a.setTroops(1000);
      game.executeNextTick();
      updatePressurePopulation(game, a);
      expect(state.civilians + a.troops()).toBeCloseTo(total + expected, 8);
      expect(pressureView(a)!.growthPerSecond).toBeCloseTo(expected * 10, 8);
    },
  );
  it("counts deployed troops equally and preserves above-cap donations", () => {
    const state = pressurePopulation(game, a);
    game.config().gameConfig().pressurePacing!.populationGrowthMultiplier = 1;
    const expected = game.config().troopIncreaseRate(a, 2000);
    a.createAttack(b, 500, null, new Set());
    a.removeTroops(500);
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(state.civilians + a.troops() + deployedTroops(a)).toBeCloseTo(
      2000 + expected,
      8,
    );
    state.civilians = game.config().maxTroops(a) * 2;
    const total = state.civilians + a.troops() + deployedTroops(a);
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(state.civilians + a.troops() + deployedTroops(a)).toBeCloseTo(
      total,
      8,
    );
    expect(state.growthPerSecond).toBe(0);
  });
  it.each([180, 1200, 3600])(
    "protects humans and nations for exactly %s game seconds, not bots",
    (seconds) => {
      game.config().gameConfig().pressureGraceSeconds = seconds;
      const clock = vi
        .spyOn(game, "elapsedGameSeconds")
        .mockReturnValue(seconds - 0.1);
      expect(hasPressureGrace(game, b)).toBe(true);
      expect(a.canAttackPlayer(b)).toBe(false);
      vi.spyOn(a, "type").mockReturnValue(PlayerType.Bot);
      expect(a.canAttackPlayer(b)).toBe(false);
      vi.spyOn(b, "type").mockReturnValue(PlayerType.Nation);
      expect(hasPressureGrace(game, b)).toBe(true);
      vi.spyOn(b, "type").mockReturnValue(PlayerType.Bot);
      expect(hasPressureGrace(game, b)).toBe(false);
      expect(hasPressureGrace(game, game.terraNullius())).toBe(false);
      vi.spyOn(b, "type").mockReturnValue(PlayerType.Nation);
      clock.mockReturnValue(seconds);
      expect(hasPressureGrace(game, b)).toBe(false);
      expect(a.canAttackPlayer(b)).toBe(true);
    },
  );
  it("uses the native intent path for a target, without instant conversion", () => {
    const state = pressurePopulation(game, a);
    const execution = new Executor(game, "pressure-test", undefined).createExec(
      { type: "mobilisation", clientID: a.clientID()!, target: 0.8 },
    );
    execution.init(game, game.ticks());
    expect(state.target).toBe(0.8);
    expect(a.troops()).toBe(1000);
    for (let i = 0; i < 50; i++) {
      game.executeNextTick();
      updatePressurePopulation(game, a);
    }
    expect(a.troops()).toBeGreaterThan(1200);
    expect(a.troops()).toBeLessThan(1500);
    expect(pressureView(a)!.civilians).toBeGreaterThan(500);
  });
  it("preserves offline alliance protection and requires expiry before betrayal", async () => {
    await ally();
    const alliance = a.allianceWith(b)!;
    b.markDisconnected(true);
    expect(a.isFriendly(b)).toBe(true);
    expect(hasProtectedAlliance(game, a, b)).toBe(true);
    a.breakAlliance(alliance);
    expect(a.isAlliedWith(b)).toBe(true);
    expect(a.isTraitor()).toBe(false);
    vi.spyOn(game, "ticks").mockReturnValue(alliance.expiresAt());
    alliance.expire();
    expect(a.isAlliedWith(b)).toBe(true);
    a.breakAlliance(alliance);
    expect(a.isAlliedWith(b)).toBe(false);
    expect(a.isTraitor()).toBe(true);
  });
  it("extends only on mutual agreement, adding to unexpired protection", async () => {
    await ally();
    const alliance = a.allianceWith(b)!,
      end = alliance.expiresAt();
    expect(a.allianceInfo(b)?.canExtend).toBe(true);
    game.addExecution(new AllianceExtensionExecution(a, b.id()));
    game.executeNextTick();
    expect(alliance.expiresAt()).toBe(end);
    game.addExecution(new AllianceExtensionExecution(b, a.id()));
    game.executeNextTick();
    expect(alliance.expiresAt()).toBe(end + 3000);
  });
  it("rejects a protected MIRV launch before spending resources", async () => {
    await ally();
    const execution = new MirvExecution(a, game.ref(0, 1));
    const before = a.gold();
    execution.init(game, game.ticks());
    expect(execution.isActive()).toBe(false);
    expect(a.gold()).toBe(before);
    expect(a.isAlliedWith(b)).toBe(true);
  });
  it("keeps donated troops conserved in native player accounting", async () => {
    await ally();
    pressurePopulation(game, a);
    pressurePopulation(game, b);
    expect(a.donateTroops(b, 300)).toBe(true);
    expect(a.troops()).toBe(700);
    expect(b.troops()).toBe(1300);
    expect(pressureView(a)!.military + pressureView(b)!.military).toBe(2000);
    expect(pressureView(a)!.civilians + pressureView(b)!.civilians).toBe(2000);
    expect(pressureIncome(a, 1000n)).toBeGreaterThan(pressureIncome(b, 1000n));
  });
  it("AFK response uses the same gradual conversion, with manual override", () => {
    const other = pressurePopulation(game, b);
    other.civilians = 100;
    pressurePopulation(game, a);
    setMobilisationTarget(game, a, 0.1);
    a.markDisconnected(true);
    b.createAttack(a, 200, null, new Set());
    b.removeTroops(200);
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(pressureView(a)!.automatic).toBe(true);
    expect(pressureView(a)!.effectiveTarget).toBeGreaterThan(0.8);
    expect(a.troops()).toBeLessThan(1050);
    a.markDisconnected(false);
    setMobilisationTarget(game, a, 0.2);
    game.executeNextTick();
    updatePressurePopulation(game, a);
    expect(pressureView(a)!.automatic).toBe(false);
    expect(pressureView(a)!.effectiveTarget).toBe(0.2);
  });
  it("starts native wilderness expansion from a bounded military budget", () => {
    const before = a.numTilesOwned();
    applyContinuousPressure(game, a, a.smallID() % 10);
    for (let i = 0; i < 30; i++) game.executeNextTick();
    expect(a.numTilesOwned()).toBeGreaterThan(before);
    expect(a.troops()).toBeLessThanOrEqual(1000);
  });
  it("passively expands wilderness without consuming population", () => {
    game.config().gameConfig().passiveWildernessExpansion = true;
    game.config().gameConfig().pressureGraceSeconds = 180;
    const before = a.numTilesOwned();
    pressurePopulation(game, a);
    applyContinuousPressure(game, a, a.smallID() % 10);
    for (let i = 0; i < 100; i++) {
      game.executeNextTick();
      expect(a.troops() + deployedTroops(a)).toBe(1000);
    }
    expect(a.numTilesOwned()).toBeGreaterThan(before);
    expect(pressurePopulation(game, a).civilians).toBe(1000);
  });
  it.each([false, true])(
    "does not merge manual and passive wilderness armies (passive first=%s)",
    (passiveFirst) => {
      game.config().gameConfig().passiveWildernessExpansion = true;
      const passive = new AttackExecution(100, a, null, null, true, true);
      const manual = new AttackExecution(100, a, null);
      for (const execution of passiveFirst
        ? [passive, manual]
        : [manual, passive])
        execution.init(game, game.ticks());
      expect(a.outgoingAttacks()).toHaveLength(2);
      const passiveArmy = a.outgoingAttacks()[passiveFirst ? 0 : 1];
      for (let i = 0; i < 20; i++) {
        manual.tick(game.ticks());
        passive.tick(game.ticks());
        game.executeNextTick();
      }
      expect(passiveArmy.troops()).toBe(100);
      expect(a.troops() + deployedTroops(a)).toBeLessThan(1000);
    },
  );
  it("does not waive casualties against an owned country", () => {
    game.config().gameConfig().passiveWildernessExpansion = true;
    vi.spyOn(a, "canAttackPlayer").mockReturnValue(true);
    const attack = new AttackExecution(500, a, b.id(), null, true, true);
    attack.init(game, game.ticks());
    for (let i = 0; i < 20 && attack.isActive(); i++) attack.tick(game.ticks());
    expect(a.troops() + deployedTroops(a)).toBeLessThan(1000);
  });
  it("runs player growth and pressure together without negative resources", () => {
    game.addExecution(new PlayerExecution(a));
    game.addExecution(new PlayerExecution(b));
    for (let i = 0; i < 300; i++) game.executeNextTick();
    expect(a.troops()).toBeGreaterThanOrEqual(0);
    expect(pressureView(a)!.civilians).toBeGreaterThanOrEqual(0);
  });
  it("conserves population through repeated mobilisation changes without combat", () => {
    pressurePopulation(game, a);
    let previous = 2000;
    for (let i = 0; i < 1800; i++) {
      if (i % 200 === 0)
        setMobilisationTarget(game, a, i % 400 === 0 ? 0.87 : 0.02);
      game.executeNextTick();
      updatePressurePopulation(game, a);
      const current = pressurePopulation(game, a).civilians + a.troops();
      expect(current).toBeGreaterThanOrEqual(previous - 0.000001);
      previous = current;
    }
  });
  it("sends mobilisation-only changes through the existing diff channel", () => {
    const pressure = {
      civilians: 100,
      military: 100,
      target: 0.5,
      effectiveTarget: 0.5,
      automatic: false,
    };
    const before = { type: GameUpdateType.Player as const, id: "a", pressure };
    const after = { ...before, pressure: { ...pressure, target: 0.8 } };
    expect(diffPlayerUpdate(before, after)?.pressure?.target).toBe(0.8);
  });
});
