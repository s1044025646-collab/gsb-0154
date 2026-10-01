// Repeatable end-to-end demonstration using only deterministic time and RNG.
// Everything is written under ./data/demo in the project.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, closeDatabase } from "../src/db/database.ts";
import type { Clock } from "../src/services/repo.ts";
import { createDesign, freezeReport, getBatch } from "../src/services/repo.ts";
import { runAnalysis, checkBalance, residuals } from "../src/services/analysis.ts";
import { generateScenario } from "../src/services/synthetic.ts";
import { writeFileSync } from "node:fs";

const dir = join(process.cwd(), "data", "demo");
rmSync(dir, { recursive: true, force: true });
const db = openDatabase(join(dir, "demo.sqlite"));
const fixedClock: Clock = (() => {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) };
})();

console.log("== Repeatable two-way ANOVA demo ==");

// 1) Synthetic scenarios (deterministic seed).
const main = generateScenario(db, "main", 3, 12345, fixedClock);
const interaction = generateScenario(db, "interaction", 3, 12345, fixedClock);
const constant = generateScenario(db, "constant", 3, 12345, fixedClock);
console.log("seeded designs:", { main: main.designId, interaction: interaction.designId, constant: constant.designId });

// 2) Balance check.
const bal = checkBalance(db, main.designId);
console.log("balance(main):", bal.balanced, "n =", bal.expectedReplicates);

// 3) Analyze main effects and interaction scenarios.
const rMain = runAnalysis(db, main.designId, fixedClock);
const rInter = runAnalysis(db, interaction.designId, fixedClock);
runAnalysis(db, constant.designId, fixedClock);

const fmt = (x: number | null) => (x === null ? "null" : x.toPrecision(4));
console.log("\n[main-effects scenario]");
for (const t of rMain.result.table) {
  console.log(`  ${t.source.padEnd(6)} SS=${fmt(t.ss)} df=${t.df} F=${fmt(t.f)} p=${fmt(t.p)} ${t.pNote ?? ""}`);
}
console.log("\n[interaction scenario]");
for (const t of rInter.result.table) {
  console.log(`  ${t.source.padEnd(6)} SS=${fmt(t.ss)} df=${t.df} F=${fmt(t.f)} p=${fmt(t.p)} ${t.pNote ?? ""}`);
}

// 4) Pairwise comparisons (raw + Holm).
console.log("\n[pairwise comparisons, factor B on main scenario — Holm family]");
for (const c of rMain.result.comparisonsB) {
  console.log(`  ${c.reference} vs ${c.comparison}: diff=${fmt(c.difference)} rawP=${fmt(c.rawP)} holmP=${fmt(c.holmP)} reject=${c.rejected}`);
}

// 5) Residuals (first few).
const res = residuals(db, main.designId);
console.log("\n[residuals, first 3]", "MSE =", fmt(res.mse));
for (const r of res.residuals.slice(0, 3)) {
  console.log(`  ${r.level_a}/${r.level_b}#${r.replicate} residual=${fmt(r.residual)} z=${fmt(r.standardized)}`);
}

// 6) Freeze + export an ANOVA table; show idempotency.
const frozen1 = freezeReport(db, rMain.batchId, "{}", fixedClock, "demo-freeze-main");
const frozen2 = freezeReport(db, rMain.batchId, "{}", fixedClock, "demo-freeze-main");
console.log("\nfreeze idempotent:", frozen1.id === frozen2.id && frozen2.reused);
const batch = getBatch(db, rMain.batchId);
const outFile = join(dir, "anova-table.json");
writeFileSync(outFile, JSON.stringify(JSON.parse(batch.result_json), null, 2));
console.log("exported frozen ANOVA table ->", outFile);

// 7) Failure path: unbalanced design is rejected, transaction leaves nothing partial.
const before = (db.prepare("SELECT COUNT(*) c FROM designs").get() as { c: number }).c;
try {
  const id_unbalanced = createDesign(
    db,
    {
      name: "broken",
      factorA: { name: "A", levels: ["a1", "a2"] },
      factorB: { name: "B", levels: ["b1", "b2"] },
      observations: [
        { level_a: "a1", level_b: "b1", replicate: 1, value: 1 },
        { level_a: "a1", level_b: "b1", replicate: 2, value: 2 },
      ],
    },
    fixedClock,
  );
  checkBalance(db, id_unbalanced);
  runAnalysis(db, id_unbalanced, fixedClock);
  console.log("ERROR: unbalanced design should have been rejected");
} catch (e) {
  const after = (db.prepare("SELECT COUNT(*) c FROM designs").get() as { c: number }).c;
  console.log("unbalanced design rejected with:", (e as Error).constructor.name, (e as { code?: string }).code ?? "", "; designs before/after =", before, after);
}

closeDatabase(db);
console.log("\nDemo complete. All files are under", dir);

