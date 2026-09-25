import { describe, expect, it, vi } from "vitest";
import { installWildernessAttackShadow } from "../../../scripts/lib/ShadowAttackVerifier";
import { captureWildernessDependencies } from "../../../scripts/lib/WildernessShadowDependencies";
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { planWildernessAttackKernel } from "../../../src/core/execution/planning/WildernessAttackKernel";
import {
  planWildernessAttack,
  type WildernessAttackEffect,
} from "../../../src/core/execution/planning/WildernessAttackPlanner";
import { AttackImpl } from "../../../src/core/game/AttackImpl";
import { PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { createGame, GameImpl } from "../../../src/core/game/GameImpl";
import { GameMapImpl, type GameMap } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { setup } from "../../util/Setup";

function mapState(map: GameMap) {
  return map.tilePages().map((page) => page.state.slice());
}

async function makeGame(paged = false, passive = false) {
  const config = new Config(
    (await setup("big_plains")).config().gameConfig(),
    null,
    false,
  );
  const w = 64,
    h = 48,
    terrain = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      terrain[y * w + x] =
        x < 4 ? 0 : 128 | ((x + y) % 17 === 0 ? 31 : ((x + y) % 3) * 10);
  const map = paged
    ? PagedGameMap.fromRowMajor(
        w,
        h,
        16,
        terrain,
        terrain.filter((t) => t & 128).length,
      )
    : new GameMapImpl(w, h, terrain, terrain.filter((t) => t & 128).length);
  const game = createGame(
    [
      new PlayerInfo("a", PlayerType.Human, "a", "a"),
      new PlayerInfo("b", PlayerType.Human, "b", "b"),
    ],
    [],
    map,
    map,
    config,
  );
  game.endSpawnPhase();
  const owner = game.player("a");
  if (passive)
    Object.assign(config.gameConfig(), {
      continuousPressure: "v1",
      passiveWildernessExpansion: true,
    });
  owner.setTroops(1_000_000);
  for (let y = 16; y <= 23; y++)
    for (let x = 16; x <= 23; x++) {
      const tile = game.ref(x, y);
      if (!game.isImpassable(tile)) owner.conquer(tile);
    }
  for (let y = 12; y <= 30; y++) {
    const tile = game.ref(29, y);
    if (!game.isImpassable(tile)) game.player("b").conquer(tile);
  }
  const execution = new AttackExecution(
    50_000,
    owner,
    game.terraNullius().id(),
    null,
    true,
    passive,
  );
  execution.init(game, game.ticks());
  return { game, map, owner, execution };
}

describe.each([
  ["guarded-reference", planWildernessAttack],
  ["isolated-kernel", planWildernessAttackKernel],
] as const)("%s", (_name, plan) => {
  it("preserves passive wilderness forces in worker and authoritative paths", async () => {
    const { game, owner, execution } = await makeGame(false, true);
    const input = execution.wildernessPlanningInput(game.ticks())!;
    expect(input.state.passiveWilderness).toBe(true);
    const planned = plan(input);
    expect(planned.kind).toBe("shadow-plan");
    execution.tick(game.ticks());
    if (planned.kind !== "shadow-plan") throw new Error("Expected a plan");
    expect(planned.effects.some((e) => e.type === "conquer")).toBe(true);
    expect(planned.state.troops).toBe(input.state.troops);
    expect(execution.wildernessPlanningInput(game.ticks())!.state).toEqual(
      planned.state,
    );
    expect(
      owner.troops() +
        owner.outgoingAttacks().reduce((sum, a) => sum + a.troops(), 0),
    ).toBe(1_000_000);
  });
  it.each([false, true])(
    "matches every ordered effect, heap tie, random state and fallout change without mutating the world, paged=%s",
    async (paged) => {
      const { game, map, owner, execution } = await makeGame(paged);
      for (let tile = 0; tile < map.width() * map.height(); tile++)
        if (tile % 5 === 0 && map.isLand(tile) && !map.hasOwner(tile))
          game.setFallout(tile, true);
      const attack = owner.outgoingAttacks()[0] as AttackImpl;
      const actual: WildernessAttackEffect[] = [];
      const add = attack.addBorderTile.bind(attack),
        remove = attack.removeBorderTile.bind(attack);
      const setTroops = attack.setTroops.bind(attack),
        conquer = owner.conquer.bind(owner);
      vi.spyOn(attack, "addBorderTile").mockImplementation((tile) => {
        actual.push({ type: "border-add", tile });
        add(tile);
      });
      vi.spyOn(attack, "removeBorderTile").mockImplementation((tile) => {
        actual.push({ type: "border-remove", tile });
        remove(tile);
      });
      vi.spyOn(attack, "setTroops").mockImplementation((troops) => {
        setTroops(troops);
        actual.push({ type: "troops", troops: attack.troops() });
      });
      vi.spyOn(owner, "conquer").mockImplementation((tile) => {
        actual.push({ type: "conquer", tile });
        conquer(tile);
      });
      for (let i = 0; i < 10; i++) {
        const input = execution.wildernessPlanningInput(game.ticks())!;
        expect(input).not.toBeNull();
        const before = map.tilePages().map((page) => page.state.slice());
        const falloutBefore = map.numTilesWithFallout();
        const planned = plan(input);
        expect(planned.kind).toBe("shadow-plan");
        expect(execution.wildernessPlanningInput(game.ticks())!.state).toEqual(
          input.state,
        );
        expect(map.tilePages().map((page) => page.state)).toEqual(before);
        expect(map.numTilesWithFallout()).toBe(falloutBefore);
        expect(actual).toEqual([]);
        execution.tick(game.ticks());
        if (planned.kind !== "shadow-plan") throw new Error("Expected a plan");
        expect(actual).toEqual(planned.effects);
        expect(execution.wildernessPlanningInput(game.ticks())!.state).toEqual(
          planned.state,
        );
        expect(planned.readTiles.length).toBeGreaterThan(0);
        actual.length = 0;
        game.executeNextTick();
      }
    },
  );

  it("does not query a stateful policy during capture and rejects customized combat", async () => {
    const { game, execution } = await makeGame();
    const input = execution.wildernessPlanningInput(game.ticks())!;
    const policy = vi.fn(() => Infinity);
    game.setAttackActivityPolicy(policy);
    expect(execution.wildernessPlanningInput(game.ticks())).toBeNull();
    expect(policy).not.toHaveBeenCalled();
    game.setAttackActivityPolicy(undefined);
    vi.spyOn(game.config(), "attackLogic").mockImplementation(() => ({
      attackerTroopLoss: 0,
      defenderTroopLoss: 0,
      tilesPerTickUsed: 1,
    }));
    expect(execution.wildernessPlanningInput(game.ticks())).toBeNull();
    expect(plan(input)).toEqual({
      kind: "fallback",
      reason: "configuration",
    });
  });

  it("falls back without effects on frontier exhaustion and zero troops", async () => {
    const { game, execution } = await makeGame();
    const input = execution.wildernessPlanningInput(game.ticks())!;
    const before = mapState(game.map());
    expect(
      plan({
        ...input,
        state: {
          ...input.state,
          heap: {
            capacity: 1,
            tiles: new Uint32Array(),
            priorities: new Float32Array(),
          },
        },
      }),
    ).toEqual({ kind: "fallback", reason: "frontier-exhausted" });
    expect(plan({ ...input, state: { ...input.state, troops: 0 } })).toEqual({
      kind: "fallback",
      reason: "attack-ended",
    });
    expect(mapState(game.map())).toEqual(before);
    expect(execution.wildernessPlanningInput(game.ticks())!.state).toEqual(
      input.state,
    );
  });

  it("fails closed when upstream combat reads a capability not represented by the planner", async () => {
    const { game, execution } = await makeGame();
    const input = execution.wildernessPlanningInput(game.ticks())!;
    const before = mapState(game.map());
    const changedUpstream = vi
      .spyOn(Config.prototype, "attackLogic")
      .mockImplementation((gm) => {
        (gm as unknown as { unmodeledRead(): void }).unmodeledRead();
        return {
          attackerTroopLoss: 0,
          defenderTroopLoss: 0,
          tilesPerTickUsed: 1,
        };
      });
    try {
      expect(plan(input)).toEqual({
        kind: "fallback",
        reason: "game.unmodeledRead",
      });
      expect(mapState(game.map())).toEqual(before);
    } finally {
      changedUpstream.mockRestore();
    }
  });

  it("does not checkpoint retreating attacks", async () => {
    const { game, execution, owner } = await makeGame();
    expect(execution.wildernessPlanningInput(game.ticks())).not.toBeNull();
    owner.outgoingAttacks()[0].orderRetreat();
    expect(execution.wildernessPlanningInput(game.ticks())).toBeNull();
  });

  it("rejects changed dependencies before a prepared plan could be reused", async () => {
    const { game, execution, owner, map } = await makeGame();
    const input = execution.wildernessPlanningInput(game.ticks())!;
    const result = plan(input);
    if (result.kind !== "shadow-plan") throw new Error("Expected plan");
    const deps = captureWildernessDependencies(input, result.readTiles);
    const current = () => execution.wildernessPlanningInput(game.ticks());
    expect(deps.conflict(current())).toBeNull();
    const attack = owner.outgoingAttacks()[0];
    attack.setTroops(input.state.troops - 1);
    expect(deps.conflict(current())).toBe("attack-state");
    attack.setTroops(input.state.troops);
    const tile = result.readTiles.find(
      (t) => map.ownerID(t) === 0 && map.isLand(t),
    )!;
    map.setOwnerID(tile, game.player("b").smallID());
    expect(deps.conflict(current())).toBe("tile-state");
    map.setOwnerID(tile, 0);
    expect(deps.conflict(current())).toBeNull();
    map.setFallout(tile, true);
    expect(deps.conflict(current())).toBe("global-terrain");
    map.setFallout(tile, false);
    map.setMagnitude(tile, map.magnitude(tile) < 10 ? 20 : 0);
    expect(deps.conflict(current())).toBe("tile-state");
  });
});

it.each([PlayerType.Bot, PlayerType.Nation, PlayerType.Human])(
  "kernel matches guarded reference for %s across pace and troop budgets",
  async (ownerType) => {
    const { game, execution } = await makeGame();
    const base = execution.wildernessPlanningInput(game.ticks())!;
    for (const divisor of [1, 5, 15, 200]) {
      const config = new Config(
        { ...base.config.gameConfig(), territoryAttackSpeedDivisor: divisor },
        null,
        false,
      );
      for (const troops of [0, 0.5, 1, 79, 1_000, 50_000, 1_000_000]) {
        const input = {
          ...base,
          config,
          state: { ...base.state, ownerType, troops },
        };
        expect(planWildernessAttackKernel(input)).toEqual(
          planWildernessAttack(input),
        );
      }
    }
  },
);

it("ahead verifier accepts unchanged plans and falls back when an earlier execution changes troops", async () => {
  const { game, owner } = await makeGame();
  let changeTroops = false;
  game.addExecution({
    init() {},
    isActive: () => true,
    activeDuringSpawnPhase: () => false,
    tick() {
      if (changeTroops) {
        const attack = owner.outgoingAttacks()[0];
        attack.setTroops(attack.troops() - 1);
      }
    },
  });
  const execution = new AttackExecution(
    50_000,
    owner,
    game.terraNullius().id(),
  );
  game.addExecution(execution);
  game.executeNextTick();
  const originalTick = AttackExecution.prototype.tick;
  const originalGameTick = Object.getPrototypeOf(game).executeNextTick;
  const shadow = installWildernessAttackShadow(game, 1, true, true);
  try {
    game.executeNextTick();
    expect(shadow.metrics.verified).toBe(1);
    changeTroops = true;
    game.executeNextTick();
    expect(shadow.metrics.conflicts["attack-state"]).toBe(1);
    expect(shadow.metrics.verified).toBe(1);
    changeTroops = false;
    game.executeNextTick();
    expect(shadow.metrics.verified).toBe(2);
  } finally {
    shadow.dispose();
  }
  expect(AttackExecution.prototype.tick).toBe(originalTick);
  expect(Object.getPrototypeOf(game).executeNextTick).toBe(originalGameTick);
});

it.each([
  "troops",
  "troops restored",
  "border order",
  "clear border",
  "retreat",
  "execute retreat",
  "delete",
  "tick",
  "config",
  "policy",
  "fallout",
])("lightweight checkpoint rejects %s changes", async (change) => {
  const { game, execution, owner } = await makeGame();
  const checkpoint = execution.wildernessPlanningCheckpoint(game.ticks())!;
  expect(checkpoint.unchanged(game.ticks())).toBe(true);
  expect(checkpoint.unchanged(game.ticks() + 1)).toBe(false);
  const attack = owner.outgoingAttacks()[0] as AttackImpl;
  switch (change) {
    case "troops":
      attack.setTroops(123);
      break;
    case "troops restored":
      attack.setTroops(123);
      attack.setTroops(checkpoint.input.state.troops);
      break;
    case "border order": {
      const tile = checkpoint.input.state.border.tiles[0];
      attack.removeBorderTile(tile);
      attack.addBorderTile(tile);
      break;
    }
    case "clear border":
      attack.clearBorder();
      break;
    case "retreat":
      attack.orderRetreat();
      break;
    case "execute retreat":
      attack.executeRetreat();
      break;
    case "delete":
      attack.delete();
      break;
    case "tick":
      execution.tick(game.ticks());
      break;
    case "config":
      game.config().gameConfig().territoryAttackSpeedDivisor = 200;
      break;
    case "policy":
      game.setAttackActivityPolicy(() => Infinity);
      break;
    case "fallout":
      game.setFallout(game.ref(8, 8), true);
      break;
  }
  expect(checkpoint.unchanged(game.ticks())).toBe(false);
});

it("checkpoint counters fail closed after integer precision is exhausted", async () => {
  const { game, execution, owner } = await makeGame();
  const attack = owner.outgoingAttacks()[0] as AttackImpl;
  (attack as unknown as { _planningVersion: number })._planningVersion =
    Number.MAX_SAFE_INTEGER;
  const checkpoint = execution.wildernessPlanningCheckpoint(game.ticks())!;
  expect(checkpoint.unchanged(game.ticks())).toBe(true);
  attack.setTroops(attack.troops());
  expect(checkpoint.unchanged(game.ticks())).toBe(false);
  expect(execution.wildernessPlanningCheckpoint(game.ticks())).toBeNull();
});

it.each([false, true])(
  "applies plans with the same world results and conquest order, paged=%s",
  async (paged) => {
    const original = await makeGame(paged),
      planned = await makeGame(paged);
    const actualOrder: number[] = [],
      plannedOrder: number[] = [];
    original.game.observeTerritory((tile) => actualOrder.push(tile));
    planned.game.observeTerritory((tile) => plannedOrder.push(tile));
    for (let i = 0; i < 10; i++) {
      const checkpoint = planned.execution.wildernessPlanningCheckpoint(
        planned.game.ticks(),
      )!;
      const plan = planWildernessAttackKernel(checkpoint.input);
      expect(plan.kind).toBe("shadow-plan");
      const before = mapState(planned.map);
      expect(
        planned.execution.tryApplyWildernessPlan(
          checkpoint,
          plan,
          planned.game.ticks(),
          () => false,
        ),
      ).toBe(false);
      expect(mapState(planned.map)).toEqual(before);
      original.execution.tick(original.game.ticks());
      expect(
        planned.execution.tryApplyWildernessPlan(
          checkpoint,
          plan,
          planned.game.ticks(),
          () => true,
        ),
      ).toBe(true);
      expect(
        planned.execution.tryApplyWildernessPlan(
          checkpoint,
          plan,
          planned.game.ticks(),
          () => true,
        ),
      ).toBe(false);
      expect(plannedOrder).toEqual(actualOrder);
      expect(mapState(planned.map)).toEqual(mapState(original.map));
      expect(
        planned.execution.wildernessPlanningInput(planned.game.ticks())?.state,
      ).toEqual(
        original.execution.wildernessPlanningInput(original.game.ticks())
          ?.state,
      );
      expect((planned.game as GameImpl)["hash"]()).toEqual(
        (original.game as GameImpl)["hash"](),
      );
      original.game.executeNextTick();
      planned.game.executeNextTick();
    }
  },
);

it("rejects invalid replacement buffers before applying effects", async () => {
  const { game, execution, map } = await makeGame();
  const checkpoint = execution.wildernessPlanningCheckpoint(game.ticks())!;
  const plan = planWildernessAttackKernel(checkpoint.input);
  if (plan.kind !== "shadow-plan") throw new Error("Expected plan");
  const invalid = {
    ...plan,
    state: { ...plan.state, heap: { ...plan.state.heap, capacity: 0 } },
  };
  const before = mapState(map);
  expect(
    execution.tryApplyWildernessPlan(
      checkpoint,
      invalid,
      game.ticks(),
      () => true,
    ),
  ).toBe(false);
  expect(mapState(map)).toEqual(before);
  expect(checkpoint.unchanged(game.ticks())).toBe(true);
});
