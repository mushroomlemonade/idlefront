// Explicitly authorized inactive playtests; retain journals and a full backup.
import { backup, DatabaseSync } from "node:sqlite";
import { PersistentWorldRepository } from "../src/server/persistent/PersistentWorldRepository";
const ids = ["world_x73N3hRe6eNszM8D", "world_R7_ZfOPvLH53LAL3", "world_fZuZPKn4lqOSOeP0", "world_FPOe0HzMZL0hjz6d", "world_JEIiqae7FioiYNVF", "world_gNWiSa6clKfTFW-2", "world_L1QKFnGrrWx8M74j"];
const dbPath = ".data/persistent-worlds.sqlite";
const db = new DatabaseSync(dbPath, { readOnly: true });
await backup(db, `.data/backups/before-retiring-stalled-tests-${Date.now()}.sqlite`);
db.close();
const repository = new PersistentWorldRepository({ dbPath });
try {
  for (const id of ids) {
    const world = repository.getWorld(id);
    if (world?.phase === "active") repository.markFinished(id);
    console.log(id, repository.getWorld(id)?.phase);
  }
} finally { repository.close(); }
