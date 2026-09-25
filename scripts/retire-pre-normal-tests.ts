import { backup, DatabaseSync } from "node:sqlite";
import { PersistentWorldRepository } from "../src/server/persistent/PersistentWorldRepository";
// User-authorized old tests only; keep current pseGYXhG untouched.
const dbPath = ".data/persistent-worlds.sqlite";
const db = new DatabaseSync(dbPath, { readOnly: true });
await backup(db, `.data/backups/before-retiring-pre-normal-${Date.now()}.sqlite`, { rate: 1_000_000 });
db.close();
const repository = new PersistentWorldRepository({ dbPath });
try {
  for (const id of ["world_RQADkoFQcCcEPv0I", "world_gng5eT0khZXaQbER"]) {
    if (repository.getWorld(id)?.phase === "active") repository.markFinished(id);
    console.log(id, repository.getWorld(id)?.phase);
  }
} finally { repository.close(); }
