import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase } from "../src/db/database.ts";
import type { DB } from "../src/db/database.ts";
import { startServer } from "../src/api/server.ts";
import type { AppServer } from "../src/api/server.ts";
import type { Clock } from "../src/services/repo.ts";
import { generateScenario } from "../src/services/synthetic.ts";

const dir = join(tmpdir(), `anova-api-${process.pid}`);
let db: DB;
let app: AppServer;
let base: string;
const clock: Clock = { now: () => new Date("2026-06-01T08:00:00Z") };

const body = {
  name: "e2e",
  factorA: { name: "Temperature", levels: ["low", "high"] },
  factorB: { name: "Material", levels: ["m1", "m2"] },
  observations: [
    { level_a: "low", level_b: "m1", replicate: 1, value: 10 },
    { level_a: "low", level_b: "m1", replicate: 2, value: 12 },
    { level_a: "low", level_b: "m2", replicate: 1, value: 20 },
    { level_a: "low", level_b: "m2", replicate: 2, value: 22 },
    { level_a: "high", level_b: "m1", replicate: 1, value: 14 },
    { level_a: "high", level_b: "m1", replicate: 2, value: 16 },
    { level_a: "high", level_b: "m2", replicate: 1, value: 24 },
    { level_a: "high", level_b: "m2", replicate: 2, value: 26 },
  ],
};

async function api(method: string, path: string, payload?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

before(async () => {
  rmSync(dir, { recursive: true, force: true });
  db = openDatabase(join(dir, "api.sqlite"));
  app = await startServer(db, clock, "127.0.0.1", 0);
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

test("health", async () => {
  const r = await api("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.time, "2026-06-01T08:00:00.000Z");
});

test("create design then analyze with valid codes", async () => {
  const created = await api("POST", "/designs", body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.design_id;
  const bal = await api("GET", `/designs/${id}/balance`);
  assert.equal(bal.json.balanced, true);
  const an = await api("POST", `/designs/${id}/analyses`);
  assert.equal(an.status, 201);
  assert.ok(an.json.result.table.length === 5);
  assert.ok(an.json.distribution.method.includes("incomplete beta"));
});

test("validation error codes and bad json", async () => {
  const bad = await api("POST", "/designs", { name: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "VALIDATION");
  const res = await fetch(`${base}/designs`, { method: "POST", body: "{not json" });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "BAD_JSON");
  const missing = await api("GET", "/designs/9999/balance");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "NOT_FOUND");
});

test("pagination metadata", async () => {
  await generateScenario(db, "main", 2, 1, clock);
  const r = await api("GET", "/designs?page=1&page_size=2");
  assert.equal(r.status, 200);
  assert.equal(r.json.pageSize, 2);
  assert.ok(r.json.total >= 2);
  assert.ok(r.json.totalPages >= 1);
  assert.equal(r.json.items.length, Math.min(2, r.json.total));
});

test("marginal comparisons expose raw and holm p", async () => {
  const created = await api("POST", "/designs", body);
  const r = await api("GET", `/designs/${created.json.design_id}/marginal-comparisons`);
  assert.equal(r.status, 200);
  for (const c of [...r.json.factorA.comparisons, ...r.json.factorB.comparisons]) {
    if (c.rawP !== null) assert.ok(typeof c.holmP === "number");
  }
  assert.ok(r.json.family.includes("Holm"));
});

test("freeze is idempotent and report persists", async () => {
  const created = await api("POST", "/designs", body);
  const an = await api("POST", `/designs/${created.json.design_id}/analyses`);
  const batchId = an.json.batchId;
  const f1 = await api("POST", `/batches/${batchId}/freeze`, { idempotency_key: "report-key-1" });
  assert.equal(f1.status, 201);
  assert.equal(f1.json.reused, false);
  const f2 = await api("POST", `/batches/${batchId}/freeze`, { idempotency_key: "report-key-1" });
  assert.equal(f2.status, 200);
  assert.equal(f2.json.report_id, f1.json.report_id);
  assert.equal(f2.json.reused, true);
  const got = await api("GET", `/reports/${f1.json.report_id}`);
  assert.equal(got.status, 200);
  assert.ok(got.json.payload.frozen_result.result.table);
});

test("zero MSE analysis returns explicit notes, not p-values", async () => {
  const constant = generateScenario(db, "constant", 2, 7, clock);
  const r = await api("POST", `/designs/${constant.designId}/analyses`);
  assert.equal(r.status, 201);
  for (const t of r.json.result.table) assert.equal(t.p, null);
  assert.ok(r.json.interpretation.cautions.some((c: string) => c.includes("no variation")));
});
