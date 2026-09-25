// User authorized retiring old games, NOT Trademaxxing. Retain all journals.
import { backup, DatabaseSync } from "node:sqlite";
import { PersistentWorldRepository } from "../src/server/persistent/PersistentWorldRepository";
const dbPath = ".data/persistent-worlds.sqlite";
const db = new DatabaseSync(dbPath, { readOnly: true });
const path = `.data/backups/before-september10-retirement-${Date.now()}.sqlite`;
await backup(db, path);
db.close();
const repo = new PersistentWorldRepository({ dbPath });
try {
  for (const id of ["world_Ft32qy49TYcnTCGb", "world_nlQq0ClgPhUHSIed"]) {
    if (repo.getWorld(id)?.phase === "active") repo.markFinished(id);
    console.log(id, repo.getWorld(id)?.phase);
  }
  console.log("Preserved current world:", repo.getWorld("world_Hw251inHljnar7Lb")?.phase);
  console.log("Backup:", path);
} finally { repo.close(); }
