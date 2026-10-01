import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export type DB = DatabaseSync;

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: DB): number {
  db.exec(MIGRATIONS[0]!.sql);
  const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  let applied = current;
  for (const m of MIGRATIONS) {
    if (m.id > current) {
      db.exec(m.sql);
      applied = m.id;
    }
  }
  db.prepare(
    `INSERT INTO schema_version (id, version) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
  ).run(applied);
  return applied;
}

export function closeDatabase(db: DB): void {
  db.close();
}
