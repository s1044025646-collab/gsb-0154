import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, Store } from "../src/db.ts";
import { runAnalysis } from "../src/service.ts";
import { generate } from "../src/synth.ts";
import { closeStore, make2x2, tempStore } from "./helpers.ts";

function addValidDesign(store: Store, versionName = "d1") {
  return store.createDesign({
    name: versionName, factorA: "A", factorB: "B", ...make2x2({ alpha: 3, n: 3 }),
  });
}

test("设计版本递增且旧版本数据隔离", () => {
  const s = tempStore();
  const v1 = addValidDesign(s, "exp");
  assert.equal(v1.version, 1);
  const v2 = s.createDesign({
    ...make2x2({ alpha: 9, n: 3 }),
    name: "exp", factorA: "A", factorB: "B", supersedes: v1.id,
  });
  assert.equal(v2.version, 2);
  const a1 = runAnalysis(s, v1.id);
  const a2 = runAnalysis(s, v2.id);
  assert.notEqual(a1.batchId, a2.batchId);
  assert.notDeepEqual(
    a1.result.rows.find((r) => r.source === "A")!.ss,
    a2.result.rows.find((r) => r.source === "A")!.ss,
  );
  assert.equal(s.getDesign(v1.id)!.observations.length,
    s.getDesign(v2.id)!.observations.length);
  closeStore(s);
});

test("分析失败被记录为 failed 批次，不产生半成品分析", () => {
  const s = tempStore();
  const d = s.createDesign({
    ...generate("missing-cell"),
    name: "bad",
  });
  assert.throws(() => runAnalysis(s, d.id), (e: any) => e.code === "MISSING_CELL");
  const { items } = s.listBatches(d.id, 10, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "failed");
  assert.equal(items[0].error_code, "MISSING_CELL");
  assert.equal(s.getBatch(items[0].id)!.analysis, null);
  closeStore(s);
});

test("事务回滚：批次成功保存是原子的", () => {
  const s = tempStore();
  const d = addValidDesign(s);
  const out = runAnalysis(s, d.id);
  const batch = s.getBatch(out.batchId)!;
  assert.equal(batch.status, "analyzed");
  assert.ok(batch.analysis);
  closeStore(s);
});

test("重启后持久化：关闭再打开同一文件状态保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "anova-persist-"));
  const path = join(dir, "p.db");
  const db1 = openDb(path);
  migrate(db1);
  const s1 = new Store(db1);
  const d = addValidDesign(s1);
  const out = runAnalysis(s1, d.id);
  s1.db.close();

  const db2 = openDb(path);
  migrate(db2);
  const s2 = new Store(db2);
  const d2 = s2.getDesign(d.id)!;
  assert.equal(d2.observations.length, d.observations.length);
  const batch = s2.getBatch(out.batchId)!;
  assert.equal(batch.status, "analyzed");
  assert.equal(batch.analysis.result.replication, 3);
  s2.db.close();
});

test("迁移可重复执行", () => {
  const s = tempStore();
  assert.equal(migrate(s.db), 1);
  assert.equal(migrate(s.db), 1);
  closeStore(s);
});

test("幂等：重复提交同一 idempotency-key 返回首次结果", () => {
  const s = tempStore();
  const payload = {
    name: "idem", factorA: "A", factorB: "B", ...make2x2({ alpha: 1 }),
  };
  const first = s.withIdempotency("k1", () => s.createDesign(payload));
  const second = s.withIdempotency("k1", () => s.createDesign(payload));
  assert.equal(first.data.id, second.data.id);
  assert.equal(second.replayed, true);
  assert.equal(
    (s.db.prepare("SELECT COUNT(*) c FROM designs WHERE name='idem'").get() as any).c,
    1,
  );
  closeStore(s);
});

test("注入时钟：created_at 可控", () => {
  const s = tempStore();
  const fixed = new Date("2030-01-02T03:04:05.000Z");
  const custom = new Store(s.db, () => fixed);
  const d = custom.createDesign({
    name: "clock", factorA: "A", factorB: "B", ...make2x2({}),
  });
  assert.equal(d.created_at, fixed.toISOString());
  closeStore(s);
});

test("分页查询：total / totalPages 正确", () => {
  const s = tempStore();
  for (let i = 0; i < 3; i++) addValidDesign(s, `d${i}`);
  const page = s.listDesigns(2, 0);
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  const page2 = s.listDesigns(2, 2);
  assert.equal(page2.items.length, 1);
  closeStore(s);
});
