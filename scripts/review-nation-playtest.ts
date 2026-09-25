// Read-only, bounded local replay review. Outputs summaries, never player credentials.
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Executor } from "../src/core/execution/ExecutionManager";
import { nationStrategy } from "../src/core/execution/nation/NationStrategy";
import { PlayerType, UnitType } from "../src/core/game/Game";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import { pressureView } from "../src/core/game/PressurePopulation";
import { createGameRunner } from "../src/core/GameRunner";
import type { GameConfig, GameStartInfo, Turn } from "../src/core/Schemas";
import { NodeGameMapLoader } from "../tests/perf/fullgame/NodeGameMapLoader";

const id = process.argv[2];
if (!id || !/^[A-Za-z0-9]{8}$/.test(id)) throw Error("Pass the exact game ID");
const db = new DatabaseSync(".data/persistent-worlds.sqlite", {
  readOnly: true,
});
const runtime = db
  .prepare("SELECT * FROM persistent_world_runtimes WHERE game_id=?")
  .get(id)!;
if (!runtime) throw Error("Runtime not found");
const roster = db
  .prepare(
    `SELECT s.client_id, i.display_name FROM persistent_world_runtime_player_status s
 JOIN persistent_world_identities i ON i.id=s.identity_id WHERE s.world_id=? ORDER BY i.created_at`,
  )
  .all(runtime.world_id);
if (roster.length !== 1)
  throw Error(
    "This bounded review currently requires one human; preserve exact roster order for multiplayer",
  );
const turns = db
  .prepare(
    "SELECT turn_json FROM persistent_world_runtime_turns WHERE world_id=? ORDER BY turn_number LIMIT 30000",
  )
  .all(runtime.world_id)
  .map((r) => JSON.parse(String(r.turn_json)) as Turn);
db.close();
const start: GameStartInfo = {
  gameID: id,
  lobbyCreatedAt: Number(runtime.starts_at),
  config: JSON.parse(String(runtime.game_config_json)) as GameConfig,
  players: roster.map((p) => ({
    clientID: String(p.client_id),
    username: String(p.display_name),
    clanTag: null,
  })),
};
const runner = await createGameRunner(
  start,
  undefined,
  new NodeGameMapLoader("resources/maps"),
  () => {},
);
const g = runner.game,
  executor = new Executor(g, id, undefined);
let warnings = 0;
console.warn = () => {
  warnings++;
};
const snapshots: unknown[] = [],
  missiles: unknown[] = [],
  wins: unknown[] = [];
const known = new Set<number>();
const began = performance.now();
let played = 0;
for (const turn of turns) {
  if (
    performance.now() - began > Number(process.argv[3] ?? 240) * 1000 ||
    played >= Number(process.argv[4] ?? 30000)
  )
    break;
  g.addExecution(...executor.createExecs(turn));
  const updates = g.executeNextTick();
  played++;
  const human = g.players().find((p) => p.type() === PlayerType.Human);
  if (played % 100 === 0 && human) {
    const nearby = human.nearby().filter((p) => p.isPlayer());
    const candidates = nearby
      .filter(
        (p) => p.isPlayer() && p.type() === PlayerType.Nation && p.isAlive(),
      )
      .map((p) => {
        if (!p.isPlayer()) return null;
        return {
          name: p.name(),
          troops: Math.round(p.troops()),
          allied: human.isFriendly(p),
          plan: { ...nationStrategy(g, p).plan },
          outgoing: p
            .outgoingAttacks()
            .filter((a) => a.isActive())
            .map((a) => {
              const target = a.target();
              return {
                target: target.isPlayer() ? target.name() : "wilderness",
                troops: Math.round(a.troops()),
              };
            }),
        };
      });
    const namibia = g
      .players()
      .find((p) => p.name().toLowerCase().includes("namibia"));
    snapshots.push({
      tick: g.ticks(),
      seconds: g.elapsedGameSeconds(),
      land: human.numTilesOwned(),
      free: Math.round(human.troops()),
      military: pressureView(human)?.military,
      gold: human.gold().toString(),
      unowned:
        g.numLandTiles() -
        g.players().reduce((n, p) => n + p.numTilesOwned(), 0),
      incoming: human
        .incomingAttacks()
        .filter((a) => a.isActive())
        .map((a) => ({
          name: a.attacker().name(),
          troops: Math.round(a.troops()),
        })),
      neighbors: candidates,
      namibia: namibia && {
        troops: Math.round(namibia.troops()),
        land: namibia.numTilesOwned(),
        plan: { ...nationStrategy(g, namibia).plan },
        friendly: human.isFriendly(namibia),
        boats: namibia.unitCount(UnitType.TransportShip),
        ships: namibia.unitCount(UnitType.Warship),
      },
    });
  }
  for (const u of g.units(
    UnitType.MIRV,
    UnitType.HydrogenBomb,
    UnitType.AtomBomb,
  )) {
    if (known.has(u.id())) continue;
    known.add(u.id());
    missiles.push({
      tick: g.ticks(),
      seconds: g.elapsedGameSeconds(),
      type: u.type(),
      owner: u.owner().name(),
      target: u.targetTile(),
    });
  }
  if (updates[GameUpdateType.Win]?.length)
    wins.push(...updates[GameUpdateType.Win]);
  g.drainPackedTileUpdates();
  g.drainPackedPlayerUpdates();
  if (played % 3000 === 0)
    console.log(
      JSON.stringify({
        played,
        elapsed: Math.round((performance.now() - began) / 1000),
      }),
    );
}
mkdirSync(".data/reviews", { recursive: true });
const path = `.data/reviews/${id}-nation-review.json`;
writeFileSync(
  path,
  JSON.stringify({
    id,
    played,
    total: turns.length,
    recordedHashes: turns.filter((t) => t.hash !== null && t.hash !== undefined)
      .length,
    warnings,
    seconds: (performance.now() - began) / 1000,
    snapshots,
    missiles,
    wins,
  }),
);
console.log(
  JSON.stringify({
    path,
    played,
    total: turns.length,
    missiles: missiles.length,
    wins: wins.length,
    warnings,
  }),
);
