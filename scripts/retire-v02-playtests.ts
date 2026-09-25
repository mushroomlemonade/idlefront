// User requested stopping running games for v0.2 development. Keep journals
// and an online SQLite backup; do not delete identities, invitations or files.
import { backup, DatabaseSync } from "node:sqlite";
import { PersistentWorldRepository } from "../src/server/persistent/PersistentWorldRepository";
const ids = ["world_c1ritc8Nu2UfqrB9", "world_j9JWSc7dN5pdmTK3"];
const dbPath = ".data/persistent-worlds.sqlite";
const db = new DatabaseSync(dbPath, { readOnly: true });
const backupPath = `.data/backups/before-v02-retirement-${Date.now()}.sqlite`;
await backup(db, backupPath); db.close();
const repository = new PersistentWorldRepository({ dbPath });
try {
  for (const id of ids) {
    if (repository.getWorld(id)?.phase === "active") repository.markFinished(id);
    console.log(id, repository.getWorld(id)?.phase);
  }
  console.log("Recovery backup:", backupPath);
} finally { repository.close(); }
