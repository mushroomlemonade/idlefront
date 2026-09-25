// Read-only journal export. Does not replay, stop, or mutate a running world.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { GameStartInfoSchema, TurnSchema } from "../src/core/Schemas";
const [startPath, outputPath] = process.argv.slice(2);
if (!startPath || !outputPath) throw new Error("Usage: START_JSON OUTPUT_JSON");
const start = GameStartInfoSchema.parse(
  JSON.parse(fs.readFileSync(startPath, "utf8")),
);
const db = new DatabaseSync(".data/persistent-worlds.sqlite", {
  readOnly: true,
});
try {
  db.exec("BEGIN");
  const world = db
    .prepare(
      "SELECT w.id,w.phase,r.game_config_json FROM persistent_worlds w JOIN persistent_world_runtimes r ON r.world_id=w.id WHERE r.game_id=?",
    )
    .get(start.gameID);
  if (!world || world.phase !== "active")
    throw new Error("Expected current active world");
  const rows = db
    .prepare(
      "SELECT turn_number,turn_json FROM persistent_world_runtime_turns WHERE world_id=? ORDER BY turn_number",
    )
    .all(String(world.id));
  const turns = rows.map((row, index) => {
    const turn = TurnSchema.parse(JSON.parse(String(row.turn_json)));
    if (row.turn_number !== index || turn.turnNumber !== index)
      throw new Error(`Journal gap at ${index}`);
    return turn;
  });
  db.exec("COMMIT");
  const payload = JSON.stringify({
    start,
    turns,
    worldID: world.id,
    frozenAt: new Date().toISOString(),
  });
  fs.writeFileSync(outputPath, payload, { flag: "wx" });
  console.log(
    JSON.stringify({
      file: outputPath,
      gameID: start.gameID,
      turns: turns.length,
      firstTurn: turns[0]?.turnNumber,
      lastTurn: turns.at(-1)?.turnNumber,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: Buffer.byteLength(payload),
    }),
  );
} finally {
  db.close();
}
