import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function integrityCheck(database, label) {
  const rows = database.prepare("PRAGMA integrity_check").all();
  if (
    rows.length !== 1 ||
    typeof rows[0] !== "object" ||
    rows[0] === null ||
    rows[0].integrity_check !== "ok"
  ) {
    throw new Error(`${label} failed PRAGMA integrity_check`);
  }
}

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  fail("Usage: node scripts/idle-db-backup.mjs SOURCE DESTINATION");
} else {
  const source = path.resolve(sourceArgument);
  const destination = path.resolve(destinationArgument);
  const partial = `${destination}.partial-${process.pid}`;
  if (!existsSync(source)) {
    fail(`Source database does not exist: ${source}`);
  } else if (existsSync(destination)) {
    fail(`Destination already exists: ${destination}`);
  } else {
    mkdirSync(path.dirname(destination), { recursive: true });
    let sourceDatabase;
    let copiedDatabase;
    try {
      sourceDatabase = new DatabaseSync(source, { readOnly: true });
      integrityCheck(sourceDatabase, "Source database");
      await backup(sourceDatabase, partial);
      sourceDatabase.close();
      sourceDatabase = undefined;

      copiedDatabase = new DatabaseSync(partial, { readOnly: true });
      integrityCheck(copiedDatabase, "Copied database");
      copiedDatabase.close();
      copiedDatabase = undefined;
      renameSync(partial, destination);
      process.stdout.write(`Verified SQLite backup created: ${destination}\n`);
    } catch (error) {
      try {
        copiedDatabase?.close();
      } catch {
        // Best effort after an already-failed verification.
      }
      try {
        sourceDatabase?.close();
      } catch {
        // Best effort after an already-failed verification.
      }
      if (existsSync(partial)) unlinkSync(partial);
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
