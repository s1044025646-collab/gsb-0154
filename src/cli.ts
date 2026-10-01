#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate, openDb, Store } from "./db.ts";
import { groupBalanced } from "./stats/anova.ts";
import { generate } from "./synth.ts";
import type { SynthScenario } from "./synth.ts";
import { ApiError, freezeReport, runAnalysis } from "./service.ts";

const DB_PATH = process.env.ANOVA_DB ?? resolve("data/app.db");

function store(): Store {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = openDb(DB_PATH);
  migrate(db);
  return new Store(db);
}

const args = process.argv.slice(2);
const cmd = args.shift();

function line(s = "") {
  process.stdout.write(s + "\n");
}

function readDesignArg(file?: string) {
  if (!file) throw new Error("用法：需要 --file <json>");
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

function fmt(x: number | null, digits = 6) {
  if (x === null) return "NA";
  if (!Number.isFinite(x)) return x > 0 ? "Inf" : "-Inf";
  return String(Number(x.toPrecision(digits)));
}

function printTable(rows: any[]) {
  line("来源        SS          df    MS          F           p");
  for (const r of rows) {
    line(
      [
        r.source.padEnd(10),
          fmt(r.ss).padStart(10),
          String(r.df).padStart(4),
          (r.ms === null ? "NA" : fmt(r.ms)).padStart(10),
          (r.f === null ? "NA" : fmt(r.f)).padStart(10),
          (r.p === null
            ? (r.pNullReason ? `NA(${r.pNullReason})` : "NA")
            : fmt(r.p)).padStart(10),
      ].join("  "),
    );
  }
}

async function main() {
  const s = store();
  const opt = Object.fromEntries(
    args.flatMap((_, i) =>
      args[i].startsWith("--") ? [[args[i].slice(2), args[i + 1]]] : []
    ),
  );

  switch (cmd) {
    case "migrate": {
      line(`迁移前数据库: ${DB_PATH}`);
      const v = migrate(s.db);
      line(`迁移完成，schema 版本 = ${v}（可重复执行）`);
      break;
    }

    case "import-design": {
      const design = opt.scenario
        ? generate(opt.scenario as SynthScenario, Number(opt.seed ?? 42))
        : readDesignArg(opt.file);
      const before = (s.db.prepare("SELECT COUNT(*) c FROM designs").get() as any).c;
      line(`导入前设计总数 = ${before}`);
      const d = s.createDesign(design);
      const after = (s.db.prepare("SELECT COUNT(*) c FROM designs").get() as any).c;
      line(`导入后设计总数 = ${after}`);
      line(`设计 ID=${d.id}  name=${d.name}  version=${d.version}  观测数=${d.observations.length}`);
      break;
    }

    case "balance": {
      const d = mustDesign(s, opt.design);
      line(`设计 ${d.name} v${d.version}：A 水平 ${d.aLevels.length} 个，B 水平 ${d.bLevels.length} 个`);
      try {
        const { replication } = groupBalanced({
          aLevels: d.aLevels, bLevels: d.bLevels, observations: d.observations,
        });
        line(`平衡：是；每格重复 n = ${replication}`);
      } catch (err: any) {
        line(`平衡：否 [${err.code}] ${err.message}`);
        process.exitCode = 2;
      }
      break;
    }

    case "analyze": {
      const d = mustDesign(s, opt.design);
      line(`分析前：设计 ${d.name} v${d.version}，观测 ${d.observations.length} 条`);
      try {
        const out = runAnalysis(s, d.id);
        line(`分析后：批次 ${out.batchId} 状态=analyzed`);
        printTable(out.result.rows);
        line("");
        line("格子均值与交互效应：");
        for (const c of out.result.cellMeans) {
          line(`  ${c.aLevel}/${c.bLevel}  n=${c.n}  mean=${fmt(c.mean)}  ab=${fmt(c.interactionEffect)}`);
        }
        for (const n of out.result.notes) line("注：" + n);
        line(`BATCH_ID=${out.batchId}`);
      } catch (err) {
        if (err instanceof ApiError) {
          line(`分析被拒绝 [${err.code}] ${err.message}`);
          process.exitCode = 2;
        } else throw err;
      }
      break;
    }

    case "compare": {
      const batch = mustBatch(s, opt.batch);
      const cmp = batch.analysis.compare;
      for (const fam of [cmp.familyA, cmp.familyB]) {
        line(`检验族（因素 ${fam.factor}）：${fam.family}`);
        line("  比较                差值          t         raw p      Holm p");
        for (const c of fam.comparisons) {
          line(
            `  ${(c.level1 + " vs " + c.level2).padEnd(16)}  ${fmt(c.difference).padStart(9)}  ${fmt(c.t).padStart(8)}  ${
              (c.rawP === null ? "NA" : fmt(c.rawP)).padStart(9)
            }  ${(c.adjustedP === null ? "NA" : fmt(c.adjustedP)).padStart(9)}`,
          );
        }
      }
      break;
    }

    case "residuals": {
      const batch = mustBatch(s, opt.batch);
      line("aLevel  bLevel  observed  predicted  residual");
      for (const r of batch.analysis.result.residuals) {
        line(`${r.aLevel.padEnd(6)} ${r.bLevel.padEnd(6)} ${fmt(r.value).padStart(9)} ${fmt(r.predicted).padStart(10)} ${fmt(r.residual).padStart(10)}`);
      }
      break;
    }

    case "freeze": {
      const before = (s.db.prepare("SELECT COUNT(*) c FROM reports").get() as any).c;
      line(`冻结前报告数 = ${before}`);
      const r = freezeReport(s, mustBatch(s, opt.batch).id);
      const after = (s.db.prepare("SELECT COUNT(*) c FROM reports").get() as any).c;
      line(`冻结后报告数 = ${after}`);
      line(`报告 ID=${r.id} sha256=${r.sha256}`);
      break;
    }

    case "export-table": {
      const batch = mustBatch(s, opt.batch);
      const payload = {
        design: { name: mustDesign(s, batch.design_id).name },
        rows: batch.analysis.result.rows,
        comparisons: batch.analysis.compare,
      };
      const out = opt.out ?? `data/anova-table-${batch.id}.json`;
      writeFileSync(resolve(out), JSON.stringify(payload, null, 2));
      line(`方差表已导出到 ${out}`);
      break;
    }

    default:
      line(
        [
          "用法: anova <command> [options]",
          "命令:",
          "  migrate                     执行可重复数据库迁移",
          "  import-design --file f.json 从 JSON 导入设计",
          "  import-design --scenario main-only|interaction|constant|unequal-replication|missing-cell|extreme-scale [--seed N]",
          "  balance --design ID         检验平衡性",
          "  analyze --design ID         执行方差分析并打印方差表",
          "  compare --batch ID          边际均值成对比较（共同 MSE + Holm）",
          "  residuals --batch ID        查看残差",
          "  freeze --batch ID           冻结报告",
          "  export-table --batch ID [--out f.json]",
        ].join("\n"),
      );
  }
}

function mustDesign(s: Store, id?: string) {
  if (!id) throw new Error("需要 --design <id>");
  const d = s.getDesign(id);
  if (!d) throw new Error(`设计不存在: ${id}`);
  return d;
}

function mustBatch(s: Store, id?: string) {
  if (!id) throw new Error("需要 --batch <id>");
  const b = s.getBatch(id);
  if (!b) throw new Error(`批次不存在: ${id}`);
  if (b.status !== "analyzed" || !b.analysis) {
    throw new Error(`批次未成功分析: status=${b.status} [${b.error_code ?? ""}] ${b.error_message ?? ""}`);
  }
  return b;
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
