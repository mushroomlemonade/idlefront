// Small native simulation fixture, independent of optional AI research scripts.
import { Config } from "../../src/core/configuration/Config";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { PlayerExecution } from "../../src/core/execution/PlayerExecution";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { createGame } from "../../src/core/game/GameImpl";
import { GameMapImpl } from "../../src/core/game/GameMap";
import { UserSettings } from "../../src/core/game/UserSettings";
import { pressurePacingForDuration } from "../../src/core/PressurePacing";

export function createNavalScenario(defenderTroops = 10_000) {
  const width = 320,
    height = 160;
  const terrain = new Uint8Array(width * height).fill(32);
  const home: number[] = [],
    island: number[] = [];
  for (let y = 40; y < 120; y++) {
    for (let x = 20; x < 90; x++) home.push(y * width + x);
    for (let x = 240; x < 280; x++) island.push(y * width + x);
  }
  for (const tile of [...home, ...island]) terrain[tile] = 128;
  const map = new GameMapImpl(
    width,
    height,
    terrain,
    home.length + island.length,
  );
  map.forEachTile((tile) => {
    if (map.isLand(tile) && map.neighbors(tile).some((n) => map.isWater(n)))
      map.setShorelineBit(tile);
  });
  const config = new Config(
    {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "default",
      bots: 0,
      donateGold: false,
      donateTroops: false,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      continuousPressure: "v1",
      pressureGraceSeconds: 0,
      pressurePacing: pressurePacingForDuration("1h"),
      spawnImmunityDuration: 0,
      disableNavMesh: true,
    },
    new UserSettings(),
    false,
  );
  const mini = new GameMapImpl(
    width,
    height,
    Uint8Array.from({ length: terrain.length }, (_, t) => map.terrainByte(t)),
    home.length + island.length,
  );
  const game = createGame([], [], map, mini, config);
  const attacker = game.addPlayer(
    new PlayerInfo("invader", PlayerType.Nation, null, "invader"),
  );
  const defender = game.addPlayer(
    new PlayerInfo("island", PlayerType.Human, null, "island"),
  );
  for (const tile of home) attacker.conquer(tile);
  for (const tile of island) defender.conquer(tile);
  attacker.setSpawnTile(map.ref(60, 80));
  defender.setSpawnTile(map.ref(260, 80));
  attacker.setTroops(100_000);
  defender.setTroops(defenderTroops);
  // Explicit midgame endowments; all subsequent costs/growth/combat are native.
  attacker.removeGold(attacker.gold());
  attacker.addGold(5_000_000n);
  defender.removeGold(defender.gold());
  defender.addGold(500_000n);
  game.endSpawnPhase();
  game.addExecution(
    new PlayerExecution(attacker),
    new PlayerExecution(defender),
  );
  const homePort = map.ref(89, 80),
    enemyPort = map.ref(240, 80);
  game.addExecution(
    new ConstructionExecution(attacker, UnitType.Port, homePort),
  );
  game.addExecution(
    new ConstructionExecution(defender, UnitType.Port, enemyPort),
  );
  return { game, attacker, defender, island, homePort, enemyPort };
}
