import { describe, expect, it } from "vitest";
import { Config } from "../src/core/configuration/Config";
import {
  Difficulty,
  GameMode,
  GameType,
  PlayerType,
} from "../src/core/game/Game";
import { GameConfig } from "../src/core/Schemas";

function config(gameMap: string, tradeShipTrafficMultiplier?: number): Config {
  return new Config(
    { gameMap, tradeShipTrafficMultiplier } as GameConfig,
    null,
    false,
  );
}

describe("expanded-world trade density", () => {
  it("preserves the upstream curve at proportional map-area population", () => {
    const normal = config("World");
    const xl = config("Expanded Earth XL");
    const ultra = config("Expanded Earth Ultra");
    // Rejections are a global consecutive-failure counter, not a population
    // quantity, so only the live ship population scales with map area.
    expect(xl.tradeShipSpawnRate(12, 400 * 4)).toBe(
      normal.tradeShipSpawnRate(12, 400),
    );
    expect(ultra.tradeShipSpawnRate(12, 400 * 16)).toBe(
      normal.tradeShipSpawnRate(12, 400),
    );
  });

  it("allows significantly denser seas before saturation on Ultra", () => {
    const normal = config("World");
    const ultra = config("Expanded Earth Ultra");
    expect(ultra.tradeShipSpawnRate(0, 400)).toBeLessThan(
      normal.tradeShipSpawnRate(0, 400),
    );
  });

  it("raises both launch frequency and fleet capacity for traffic stress tests", () => {
    const normal = config("Great Lakes");
    const stress = config("Great Lakes", 5);

    expect(stress.tradeShipSpawnRate(0, 0)).toBeLessThanOrEqual(
      Math.ceil(normal.tradeShipSpawnRate(0, 0) / 5),
    );
    expect(stress.tradeShipSpawnRate(12, 400 * 5)).toBeLessThan(
      normal.tradeShipSpawnRate(12, 400),
    );
  });
});

describe("quick-start pacing multipliers", () => {
  const baseConfig = {
    gameMap: "Great Lakes",
    gameMapSize: "Normal",
    difficulty: Difficulty.Medium,
    donateGold: false,
    donateTroops: false,
    gameType: GameType.Private,
    gameMode: GameMode.FFA,
    nations: "default",
    bots: 100,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  } as GameConfig;

  it("spawns trains at 5x the normal probability", () => {
    const normal = new Config(baseConfig, null, false);
    const stress = new Config(
      { ...baseConfig, trainTrafficMultiplier: 5 },
      null,
      false,
    );
    expect(stress.trainSpawnRate(10)).toBe(
      Math.floor(normal.trainSpawnRate(10) / 5),
    );
  });

  it("slows territorial push speed by 15x", () => {
    const normal = new Config(baseConfig, null, false);
    const stress = new Config(
      { ...baseConfig, territoryAttackSpeedDivisor: 15 },
      null,
      false,
    );
    const attacker = {
      type: () => PlayerType.Human,
      troops: () => 150_000,
    } as never;
    const defender = {
      isPlayer: () => true,
      troops: () => 100_000,
    } as never;
    const normalSpeed = normal.attackTilesPerTick(
      75_000,
      attacker,
      defender,
      4,
    );
    expect(
      stress.attackTilesPerTick(75_000, attacker, defender, 4),
    ).toBeCloseTo(normalSpeed / 15, 10);
  });
});
