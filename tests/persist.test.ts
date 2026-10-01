import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase, migrate } from "../src/db/database.ts";
import type { DB } from "../src/db/database.ts";
import { createDesign, getDesignMeta } from "../src/services/repo.ts";
import type { Clock } from "../src/services/repo.ts";
import { runAnalysis } from "../src/services/analysis.ts";

const dir = join(tmpdir(), `anova-persist-${process.pid}`);
const dbPath = join(dir, "p.sqlite");
const clock: Clock = { now: () => new Date("2026-03-03T00:00:00Z") };

const mk = () => ({
  name: "persist",
  factorA: { name: "A", levels: ["x", "y"] },
  factorB: { name: "B", levels: ["u", "v"] },
  observations: [
    { level_a: "x", level_b: "u", replicate: 1, value: 1 },
    { level_a: "x", level_b: "u", replicate: 2, value: 3 },
    { level_a: "x", level_b: "v", replicate: 1, value: 5 },
    { level_a: "x", level_b: "v", replicate: 2, value: 7 },
    { level_a: "y", level_b: "u", replicate: 1, value: 2 },
    { level_a: "y", level_b: "u", replicate: 2, value: 4 },
    { level_a: "y", level_b: "v", replicate: 1, value: 6 },
    { level_a: "y", level_b: "v", replicate: 2, value: 8 },
  ],
});

before(() => rmSync(dir, { recursive: true, force: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

test("data survives close + reopen; migrations repeatable", () => {
  let db: DB = openDatabase(dbPath);
  const id = createDesign(db, mk(), clock);
  const report = runAnalysis(db, id, clock);
  const batchId = report.batchId;
  closeDatabase(db);
  assert.ok(existsSync(dbPath));

  db = openDatabase(dbPath);
  // re-running migrate on an existing DB is a harmless no-op
  assert.equal(migrate(db), 1);
  assert.equal(getDesignMeta(db, id).name, "persist");
  const reopened = runAnalysis(db, id, clock);
  assert.notEqual(reopened.batchId, batchId, "reanalysis creates a new batch");
  assert.ok(Math.abs(reopened.result.grandMean - report.result.grandMean) < 1e-12);
  const count = (db.prepare("SELECT COUNT(*) c FROM analysis_batches WHERE design_id=?").get(id) as { c: number }).c;
  assert.equal(count, 2, "both batches persisted across restart");
  closeDatabase(db);
});
