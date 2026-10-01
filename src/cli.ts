import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db/database.ts";
import { systemClock, createDesign, getDesignMeta } from "./services/repo.ts";
import { checkBalance, runAnalysis, residuals } from "./services/analysis.ts";
import { freezeReport, getBatch } from "./services/repo.ts";
import { generateScenario } from "./services/synthetic.ts";
import { AppError } from "./types.ts";

const DATA_DIR = process.env.ANOVA_DATA_DIR ?? join(process.cwd(), "data");
const db = openDatabase(process.env.ANOVA_DB ?? join(DATA_DIR, "anova.sqlite"));

const args = process.argv.slice(2);
const cmd = args.shift();

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const line = "─".repeat(64);
function hr(title: string): void {
  console.log(`\n${line}\n${title}\n${line}`);
}

function fmt(x: number | null, digits = 4): string {
  if (x === null) return "—";
  if (!Number.isFinite(x)) return String(x);
  if (Math.abs(x) >= 1e4 || (x !== 0 && Math.abs(x) < 1e-3)) return x.toExponential(3);
  return x.toFixed(digits);
}

function printAnova(report: ReturnType<typeof runAnalysis>): void {
  const r = report.result;
  console.log(
    ["Source", "SS", "df", "MS", "F", "p", "note"].map((h) => h.padEnd(h === "Source" ? 22 : 12)).join(""),
  );
  for (const t of r.table) {
    console.log(
      [
        t.label.padEnd(22),
        fmt(t.ss, 3).padStart(12),
        String(t.df).padStart(12),
        fmt(t.ms, 3).padStart(12),
        fmt(t.f, 3).padStart(12),
        fmt(t.p, 4).padStart(12),
        t.pNote ?? "",
      ].join(""),
    );
  }
  console.log("\nCell means and interaction effects:");
  for (const c of r.cells) {
    console.log(
      `  ${c.level_a}/${c.level_b}  n=${c.n}  mean=${fmt(c.mean, 3)}  interaction=${fmt(c.interaction, 3)}`,
    );
  }
  console.log("\nEffect sizes (eta^2 = SS_source / SS_total):");
  for (const [k, v] of Object.entries(report.interpretation.effectSizes)) {
    console.log(`  ${k.padEnd(3)} ${fmt(v as number, 4)}`);
  }
  if (report.interpretation.cautions.length) {
    console.log("\nInterpretation cautions:");
    for (const c of report.interpretation.cautions) console.log(`  ! ${c}`);
  }
}

function printComparisons(report: ReturnType<typeof runAnalysis>): void {
  for (const [name, comps] of [
    ["Factor A", report.result.comparisonsA],
    ["Factor B", report.result.comparisonsB],
  ] as const) {
    hr(`Pairwise marginal means — ${name} (Holm within this family, alpha=0.05)`);
    console.log("  pair".padEnd(14), "diff".padStart(12), "SE".padStart(10), "raw p".padStart(12), "Holm p".padStart(12), "reject");
    for (const c of comps) {
      console.log(
        `${c.reference}-${c.comparison}`.padEnd(14),
        fmt(c.difference, 3).padStart(12),
        fmt(c.se, 3).padStart(10),
        fmt(c.rawP).padStart(12),
        fmt(c.holmP).padStart(12),
        c.rejected === null ? c.note ?? "—" : c.rejected ? "yes" : "no",
      );
    }
  }
}

async function main(): Promise<void> {
  try {
    switch (cmd) {
      case "import": {
        const file = flag("file");
        if (!file) throw new AppError("VALIDATION", "usage: import --file design.json [--supersedes N] [--idem-key K]");
        const json = JSON.parse(readFileSync(file, "utf8"));
        const before = (db.prepare("SELECT COUNT(*) c FROM designs").get() as { c: number }).c;
        const id = createDesign(
          db,
          {
            name: json.name,
            factorA: json.factorA,
            factorB: json.factorB,
            observations: json.observations,
            supersedes: flag("supersedes") ? Number(flag("supersedes")) : undefined,
            idempotencyKey: flag("idem-key"),
          },
          systemClock,
        );
        const after = (db.prepare("SELECT COUNT(*) c FROM designs").get() as { c: number }).c;
        console.log(`designs before=${before} after=${after}; imported design_id=${id} (v${getDesignMeta(db, id).version})`);
        break;
      }
      case "balance": {
        const id = Number(flag("design"));
        const b = checkBalance(db, id);
        console.log(`design ${id} balanced=${b.balanced} expectedReplicates=${b.expectedReplicates}`);
        for (const c of b.cells) console.log(`  ${c.level_a}/${c.level_b}: n=${c.n}`);
        for (const p of b.problems) console.log(`  ! [${p.code}] ${p.message}`);
        break;
      }
      case "analyze": {
        const id = Number(flag("design"));
        hr(`BEFORE: design ${id}`);
        console.log(getDesignMeta(db, id));
        const batchesBefore = (db.prepare("SELECT COUNT(*) c FROM analysis_batches WHERE design_id=?").get(id) as { c: number }).c;
        const report = runAnalysis(db, id, systemClock);
        hr(`ANOVA design ${id} (v${report.designVersion}) -> batch ${report.batchId}`);
        printAnova(report);
        const batchesAfter = (db.prepare("SELECT COUNT(*) c FROM analysis_batches WHERE design_id=?").get(id) as { c: number }).c;
        console.log(`\nbatches before=${batchesBefore} after=${batchesAfter}`);
        break;
      }
      case "compare": {
        const id = Number(flag("design"));
        const report = runAnalysis(db, id, systemClock);
        printComparisons(report);
        break;
      }
      case "residuals": {
        const id = Number(flag("design"));
        const { residuals: rs, mse } = residuals(db, id);
        console.log(`MSE=${fmt(mse, 4)}`);
        for (const r of rs) {
          console.log(
            `  ${r.level_a}/${r.level_b}#${r.replicate} obs=${fmt(r.observed, 3)} fit=${fmt(r.fitted, 3)} res=${fmt(r.residual, 3)} z=${fmt(r.standardized, 3)}`,
          );
        }
        break;
      }
      case "freeze": {
        const batchId = Number(flag("batch"));
        const batch = getBatch(db, batchId);
        const payload = { batch, frozen_result: JSON.parse(batch.result_json) };
        const rep = freezeReport(db, batchId, JSON.stringify(payload), systemClock, flag("idem-key"));
        console.log(`frozen report_id=${rep.id} batch=${batchId} reused=${rep.reused}`);
        break;
      }
      case "export": {
        const batchId = Number(flag("batch"));
        const out = flag("out") ?? join(DATA_DIR, `anova-table-batch-${batchId}.json`);
        const batch = getBatch(db, batchId);
        writeFileSync(out, JSON.stringify(JSON.parse(batch.result_json), null, 2));
        console.log(`exported batch ${batchId} ANOVA table -> ${out}`);
        break;
      }
      case "seed": {
        const scenario = (flag("scenario") ?? "main") as "main" | "interaction" | "constant" | "extreme";
        const n = Number(flag("n") ?? "3");
        const res = generateScenario(db, scenario, n, Number(flag("seed") ?? "12345"), systemClock);
        console.log(`seeded scenario=${res.scenario} n=${n} design_id=${res.designId}`);
        break;
      }
      default:
        console.log(
          [
            "usage:",
            "  import --file design.json [--supersedes N] [--idem-key K]",
            "  seed --scenario main|interaction|constant|extreme [--n 3] [--seed 12345]",
            "  balance --design ID",
            "  analyze --design ID",
            "  compare --design ID",
            "  residuals --design ID",
            "  freeze --batch ID [--idem-key K]",
            "  export --batch ID [--out file.json]",
          ].join("\n"),
        );
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`ERROR [${err.code}] ${err.message}`);
      if (err.details) console.error("details:", err.details);
      process.exitCode = 1;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

await main();
