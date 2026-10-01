import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase } from "../src/db/database.ts";
import type { DB } from "../src/db/database.ts";
import { createDesign, getDesignMeta } from "../src/services/repo.ts";
import type { Clock } from "../src/services/repo.ts";
import { checkBalance, runAnalysis, residuals } from "../src/services/analysis.ts";
import { generateScenario } from "../src/services/synthetic.ts";
import { AppError } from "../src/types.ts";

const dir = join(tmpdir(), `anova-repo-${process.pid}`);
const dbPath = join(dir, "t.sqlite");
let db: DB;
const clock: Clock = { now: () => new Date("2026-01-01T00:00:00Z") };

const balanced = {
  name: "d",
  factorA: { name: "A", levels: ["a1", "a2"] },
  factorB: { name: "B", levels: ["b1", "b2"] },
  observations: [
    { level_a: "a1", level_b: "b1", replicate: 1, value: 10 },
    { level_a: "a1", level_b: "b1", replicate: 2, value: 12 },
    { level_a: "a1", level_b: "b2", replicate: 1, value: 20 },
    { level_a: "a1", level_b: "b2", replicate: 2, value: 22 },
    { level_a: "a2", level_b: "b1", replicate: 1, value: 14 },
    { level_a: "a2", level_b: "b1", replicate: 2, value: 16 },
    { level_a: "a2", level_b: "b2", replicate: 1, value: 24 },
    { level_a: "a2", level_b: "b2", replicate: 2, value: 26 },
  ],
};

before(() => {
  rmSync(dir, { recursive: true, force: true });
  db = openDatabase(dbPath);
});
after(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

test("transaction rolls back on invalid observation", () => {
  const before = (db.prepare("SELECT COUNT(*) c FROM designs").get() as { c: number }).c;
  const bad = {
    ...balanced,
    name: "bad",
    observations: [...balanced.observations, { level_a: "a1", level_b: "b1", replicate: 1, value: 5 }],
  };
  assert.throws(() => createDesign(db, bad, clock), (e: AppError) => e.code === "CONFLICT");
  const afterCount = (db.prepare("SELECT COUNT(*) c FROM designs").get() as { c: number }).c;
  assert.equal(afterCount, before, "no design/rows should be left after rollback");
});

test("import, balance and analysis round trip", () => {
  const id = createDesign(db, balanced, clock);
  assert.equal(getDesignMeta(db, id).version, 1);
  const bal = checkBalance(db, id);
  assert.equal(bal.balanced, true);
  const report = runAnalysis(db, id, clock);
  assert.equal(report.result.nPerCell, 2);
  assert.equal(report.result.errorDf, 4);
  assert.equal(report.designVersion, 1);
  const res = residuals(db, id);
  assert.equal(res.residuals.length, 8);
});

test("design version isolation: superseding does not alter old version", () => {
  const oldId = createDesign(db, balanced, clock);
  const newId = createDesign(
    db,
    {
      ...balanced,
      name: "d2",
      supersedes: oldId,
      observations: balanced.observations.map((o) => ({ ...o, value: o.value + 100 })),
    },
    clock,
  );
  assert.equal(getDesignMeta(db, newId).version, 2);
  const oldReport = runAnalysis(db, oldId, clock);
  const newReport = runAnalysis(db, newId, clock);
  assert.ok(Math.abs(oldReport.result.grandMean - 18) < 1e-9);
  assert.ok(Math.abs(newReport.result.grandMean - 118) < 1e-9);
  // batch records keep the design version frozen at analysis time
  assert.equal(oldReport.designVersion, 1);
  assert.equal(newReport.designVersion, 2);
});

test("idempotent create by key", () => {
  const id1 = createDesign(db, { ...balanced, name: "idem", idempotencyKey: "k-123" }, clock);
  const id2 = createDesign(db, { ...balanced, name: "idem", idempotencyKey: "k-123" }, clock);
  assert.equal(id1, id2);
});

test("unbalanced data rejected at analysis, balance endpoint reports problems", () => {
  const id = createDesign(
    db,
    { ...balanced, name: "unbal", observations: balanced.observations.slice(0, 7) },
    clock,
  );
  const bal = checkBalance(db, id);
  assert.equal(bal.balanced, false);
  assert.ok(bal.problems.some((p) => p.code === "MISSING_CELL" || p.code === "UNEQUAL_REPLICATES"));
  assert.throws(() => runAnalysis(db, id, clock), (e: AppError) =>
    ["MISSING_CELL", "UNEQUAL_REPLICATES"].includes(e.code),
  );
});

test("synthetic scenarios analyze", () => {
  const main = generateScenario(db, "main", 3, 42, clock);
  const r = runAnalysis(db, main.designId, clock);
  assert.ok(r.result.table.find((t) => t.source === "A")!.f! > 1);
  const inter = generateScenario(db, "interaction", 3, 42, clock);
  const ri = runAnalysis(db, inter.designId, clock);
  assert.ok(ri.result.table.find((t) => t.source === "AB")!.f! > 1);
});
