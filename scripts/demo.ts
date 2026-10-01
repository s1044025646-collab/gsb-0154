/**
 * 可重复端到端演示：使用独立的 data/demo.db，依次走
 * 合成数据 -> 导入 -> 平衡 -> 分析 -> 比较 -> 残差 -> 冻结 -> 导出。
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrate, openDb, Store } from "../src/db.ts";
import { generate } from "../src/synth.ts";
import { freezeReport, runAnalysis } from "../src/service.ts";

const dbPath = resolve("data/demo.db");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
}
const db = openDb(dbPath);
migrate(db);
const store = new Store(db);

function say(s: string) {
  console.log(s);
}

say("== 场景 1：纯主效应 + 弱噪声（seed=7，可复现）==");
const d1 = store.createDesign(generate("main-only", 7));
say(`设计 ${d1.name} v${d1.version}，观测 ${d1.observations.length} 条`);
const a1 = runAnalysis(store, d1.id);
for (const r of a1.result.rows) {
  say(
    `${r.source.padEnd(6)} SS=${r.ss.toFixed(4)} df=${r.df} ` +
    `MS=${r.ms === null ? "NA" : r.ms.toFixed(4)} F=${r.f === null ? "NA" : Number(r.f).toFixed(3)} p=${r.p === null ? "NA" : r.p.toExponential(3)}`,
  );
}
const rep = freezeReport(store, a1.batchId);
say(`冻结报告 ${rep.id} sha256=${rep.sha256}`);

say("\n== 场景 2：纯交互（边际均值无差异但格子效应非零）==");
const d2 = store.createDesign(generate("interaction", 7));
const a2 = runAnalysis(store, d2.id);
say(`交互 SS=${a2.result.rows[2].ss.toFixed(4)}，主效应 SS_A=${a2.result.rows[0].ss} SS_B=${a2.result.rows[1].ss}`);
for (const n of a2.result.notes) say("注：" + n);

say("\n== 场景 3：全常量（MSE=0，无变异）被正确处理 ==");
const d3 = store.createDesign(generate("constant", 7));
const a3 = runAnalysis(store, d3.id);
say(`mseZero=${a3.result.mseZero}；A.p=${a3.result.rows[0].p}`);

say("\n== 场景 4：不等重复被拒绝 ==");
const d4 = store.createDesign(generate("unequal-replication", 7));
try {
  runAnalysis(store, d4.id);
} catch (e: any) {
  say(`拒绝 [${e.code}] ${e.message}`);
}

say("\n== 场景 5：极端尺度（均值 ~1e9，平移到 1e12）数值稳定 ==");
const g5 = generate("extreme-scale", 7, { n: 4 });
g5.observations.forEach((o) => { o.value += 1e12; });
const d5 = store.createDesign(g5);
const a5 = runAnalysis(store, d5.id);
const ss = Object.fromEntries(a5.result.rows.map((r) => [r.source, r.ss]));
const rel = Math.abs(ss.A + ss.B + ss.AB + ss.error - ss.total) / ss.total;
say(`分解相对误差=${rel.toExponential(2)}，F_A=${a5.result.rows[0].f!.toFixed(3)}`);

writeFileSync(
  resolve("data/demo-export.json"),
  JSON.stringify({ rows: a1.result.rows, compare: a1.compare }, null, 2),
);
say("\n演示数据已写入 data/demo.db 与 data/demo-export.json");
db.close();
