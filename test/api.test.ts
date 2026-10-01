import test from "node:test";
import assert from "node:assert/strict";
import { after, before, describe } from "node:test";
import type { Server } from "node:http";
import { listenLocal } from "../src/api.ts";
import type { Store } from "../src/db.ts";
import { closeStore, make2x2, tempStore } from "./helpers.ts";

describe("HTTP API 端到端", () => {
  let server: Server;
  let port: number;
  let store: Store;
  let base: string;

  before(async () => {
    store = tempStore();
    const up = await listenLocal(store, 0, "127.0.0.1");
    server = up.server;
    port = up.port;
    base = `http://127.0.0.1:${port}`;
  });
  after(() => {
    server.close();
    closeStore(store);
  });

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(base + path, {
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      ...init,
    });
    const body = await res.json();
    return { status: res.status, body: body as any };
  }

  test("健康检查", async () => {
    const r = await api("/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test("参数校验：缺字段返回 400 与明确错误码", async () => {
    const r = await api("/designs", { method: "POST", body: JSON.stringify({ name: "" }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "VALIDATION_ERROR");
  });

  test("非有限观测在 API 层被拒绝", async () => {
    const payload = {
      name: "badval", factorA: "A", factorB: "B",
      aLevels: ["a1", "a2"], bLevels: ["b1", "b2"],
      observations: [{ aLevel: "a1", bLevel: "b1", value: "x" }],
    };
    const r = await api("/designs", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "VALIDATION_ERROR");
  });

  test("完整流程：建设计 -> 平衡 -> 分析 -> 比较 -> 冻结 -> 查询", async () => {
    const payload = {
      name: "e2e", factorA: "Temp", factorB: "Pressure",
      ...make2x2({ alpha: 4, beta: 1, ab: 2, n: 3, noise: 0.6 }),
    };
    const created = await api("/designs", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(created.status, 201);
    const designId = created.body.id;

    const bal = await api(`/designs/${designId}/balance`);
    assert.equal(bal.status, 200);
    assert.equal(bal.body.balanced, true);
    assert.equal(bal.body.replication, 3);

    const analysis = await api("/analyses", {
      method: "POST",
      body: JSON.stringify({ designId }),
    });
    assert.equal(analysis.status, 201);
    const batchId = analysis.body.batchId;
    assert.ok(Array.isArray(analysis.body.result.rows));
    assert.ok(analysis.body.compare.familyA.comparisons[0].rawP !== null);

    const resid = await api(`/batches/${batchId}/residuals`);
    assert.equal(resid.status, 200);
    assert.equal(resid.body.residuals.length, 12);

    const report = await api("/reports/freeze", {
      method: "POST",
      body: JSON.stringify({ batchId }),
    });
    assert.equal(report.status, 201);
    assert.match(report.body.sha256, /^[0-9a-f]{64}$/);

    const list = await api("/reports?page=1&pageSize=10");
    assert.equal(list.body.total, 1);
    assert.equal(list.body.totalPages, 1);

    const one = await api(`/reports/${report.body.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.payload.design.name, "e2e");
  });

  test("失败路径：缺失格子分析返回 422 与错误码", async () => {
    const full = make2x2({});
    const payload = {
      name: "missing", factorA: "A", factorB: "B",
      aLevels: full.aLevels, bLevels: full.bLevels,
      observations: full.observations.filter(
        (o) => !(o.aLevel === "a2" && o.bLevel === "b2")),
    };
    const created = await api("/designs", { method: "POST", body: JSON.stringify(payload) });
    const r = await api("/analyses", {
      method: "POST", body: JSON.stringify({ designId: created.body.id }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, "MISSING_CELL");
  });

  test("幂等键：重复分析返回同一批次", async () => {
    const payload = { name: "idem", factorA: "A", factorB: "B", ...make2x2({ alpha: 2 }) };
    const created = await api("/designs", { method: "POST", body: JSON.stringify(payload) });
    const a1 = await api("/analyses", {
      method: "POST",
      headers: { "idempotency-key": "analyze-1" },
      body: JSON.stringify({ designId: created.body.id }),
    });
    const a2 = await api("/analyses", {
      method: "POST",
      headers: { "idempotency-key": "analyze-1" },
      body: JSON.stringify({ designId: created.body.id }),
    });
    assert.equal(a1.body.batchId, a2.body.batchId);
  });

  test("未知路由 404", async () => {
    const r = await api("/nope");
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "NOT_FOUND");
  });
});
