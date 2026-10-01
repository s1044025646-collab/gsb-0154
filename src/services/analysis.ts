import { AppError } from "../types.ts";
import type { AnovaResult, AnovaTableRow } from "../types.ts";
import type { DB } from "../db/database.ts";
import { anova } from "../stats/anova.ts";
import { createBatch, getDesignMeta, loadDesignData } from "./repo.ts";
import type { Clock } from "./repo.ts";

export interface BalanceReport {
  balanced: boolean;
  factorA: { name: string; levels: string[] };
  factorB: { name: string; levels: string[] };
  expectedReplicates: number | null;
  cells: { level_a: string; level_b: string; n: number }[];
  problems: { code: string; message: string }[];
}

/** Inspect balance without throwing; collects structural problems. */
export function checkBalance(db: DB, designId: number): BalanceReport {
  const data = loadDesignData(db, designId);
  const problems: { code: string; message: string }[] = [];
  const cells: BalanceReport["cells"] = [];
  let expected: number | null = null;
  for (let i = 0; i < data.factorA.levels.length; i++) {
    for (let j = 0; j < data.factorB.levels.length; j++) {
      const vals = data.matrix[i]![j]!;
      const n = vals.length;
      cells.push({ level_a: data.factorA.levels[i]!, level_b: data.factorB.levels[j]!, n });
      if (n === 0) {
        problems.push({ code: "MISSING_CELL", message: `cell (${data.factorA.levels[i]},${data.factorB.levels[j]}) is empty` });
      } else {
        for (const v of vals) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            problems.push({ code: "NON_FINITE", message: `cell (${data.factorA.levels[i]},${data.factorB.levels[j]}) has non-finite value` });
          }
        }
        if (expected === null) expected = n;
        else if (n !== expected) {
          problems.push({ code: "UNEQUAL_REPLICATES", message: `cell (${data.factorA.levels[i]},${data.factorB.levels[j]}) n=${n}, expected ${expected}` });
        }
      }
    }
  }
  if (expected !== null && expected < 2) {
    problems.push({ code: "INSUFFICIENT_REPLICATES", message: `each cell needs >=2 replicates, n=${expected}` });
  }
  return {
    balanced: problems.length === 0,
    factorA: { name: data.factorA.name, levels: data.factorA.levels },
    factorB: { name: data.factorB.name, levels: data.factorB.levels },
    expectedReplicates: expected,
    cells,
    problems,
  };
}

/** Eta-squared effect sizes (proportion of total SS attributable to source). */
export function effectSizes(result: AnovaResult): Record<"A" | "B" | "AB", number> {
  const total = result.table.find((r) => r.source === "Total")!.ss;
  const get = (s: "A" | "B" | "AB") => result.table.find((r) => r.source === s)!.ss;
  if (total === 0) return { A: 0, B: 0, AB: 0 };
  return {
    A: get("A") / total,
    B: get("B") / total,
    AB: get("AB") / total,
  };
}

export interface Interpretation {
  significance: { source: string; significant: boolean; p: number | null; alpha: number; note: string | null }[];
  effectSizes: Record<"A" | "B" | "AB", number>;
  cautions: string[];
  assumptions: string[];
}

/**
 * Narrative that separates significance, effect size and assumptions.
 * Never reduces the result to a threshold decision.
 */
export function interpret(result: AnovaResult, alpha = 0.05): Interpretation {
  const sig = result.table
    .filter((r) => r.source !== "Error" && r.source !== "Total")
    .map((r) => ({
      source: r.source,
      significant: r.p === null ? false : r.p < alpha,
      p: r.p,
      alpha,
      note: r.pNote,
    }));

  const es = effectSizes(result);
  const abRow = result.table.find((r) => r.source === "AB")!;
  const cautions: string[] = [];
  if (abRow.p !== null && abRow.p < alpha) {
    cautions.push(
      "Interaction A×B is significant: marginal (main-effect) means do NOT describe a uniform effect. Interpret simple effects / cell means first.",
    );
  }
  if (result.table.find((r) => r.source === "Error")!.pNote === "ZERO_MSE_NO_VARIATION") {
    cautions.push("Error MS is zero and data are fully constant: there is no variation to test; no ordinary p-value is produced.");
  }
  if (result.table.find((r) => r.source === "Error")!.pNote === "ZERO_MSE_PERFECT_FIT") {
    cautions.push("Error MS is zero despite between-cell structure: the saturated cell-mean model fits exactly; F ratios are undefined (division by zero), no ordinary p-value is produced.");
  }

  const assumptions = [
    "Independent replicates within and across cells (assumed by design).",
    "Normality of residuals (not proven here; inspect residuals).",
    "Homoscedasticity across cells (balanced design makes F robust to moderate variance differences).",
    "Fixed categorical factors; results apply to the observed levels, not a random population of levels.",
  ];

  return { significance: sig, effectSizes: es, cautions, assumptions };
}

export interface AnalysisReport {
  batchId: number;
  designId: number;
  designVersion: number;
  createdAt: string;
  result: AnovaResult;
  interpretation: Interpretation;
  distribution: {
    method: string;
    accuracy: string;
  };
}

export const DISTRIBUTION_INFO = {
  method:
    "Regularized incomplete beta I_x(a,b) via Lentz continued fraction; F upper tail = I_{df2/(df2+df1 F)}(df2/2, df1/2); two-sided t = I_{df/(df+t^2)}(df/2, 1/2).",
  accuracy:
    "logGamma Lanczos rel. err < 1e-15; continued fraction tolerance 1e-15 (max 400 iters); F/t probabilities accurate ~1e-12 to 1e-14; small tails evaluated directly.",
};

/** Run ANOVA and persist an analysis batch in one transaction. */
export function runAnalysis(db: DB, designId: number, clock: Clock): AnalysisReport {
  const meta = getDesignMeta(db, designId);
  const data = loadDesignData(db, designId);
  let result: AnovaResult;
  try {
    result = anova(data.factorA, data.factorB, data.matrix);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("INTERNAL", "analysis failed", (err as Error).message);
  }
  const interpretation = interpret(result);
  const payload = { result, interpretation, distribution: DISTRIBUTION_INFO };
  let batchId: number;
  db.exec("BEGIN IMMEDIATE");
  try {
    batchId = createBatch(db, designId, meta.version, JSON.stringify(payload), clock);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    batchId,
    designId,
    designVersion: meta.version,
    createdAt: clock.now().toISOString(),
    result,
    interpretation,
    distribution: DISTRIBUTION_INFO,
  };
}

export interface Residual {
  level_a: string;
  level_b: string;
  replicate: number;
  observed: number;
  fitted: number;
  residual: number;
  standardized: number | null;
}

/** Per-observation residuals from the cell-mean (full factorial) fit. */
export function residuals(db: DB, designId: number): { residuals: Residual[]; mse: number } {
  const data = loadDesignData(db, designId);
  const result = anova(data.factorA, data.factorB, data.matrix);
  const fitted = new Map<string, number>();
  for (const c of result.cells) fitted.set(`${c.level_a}|${c.level_b}`, c.mean);
  const out: Residual[] = [];
  const obs = db
    .prepare("SELECT level_a, level_b, replicate, value FROM observations WHERE design_id = ? ORDER BY level_a, level_b, replicate")
    .all(designId) as { level_a: string; level_b: string; replicate: number; value: number }[];
  for (const o of obs) {
    const fit = fitted.get(`${o.level_a}|${o.level_b}`)!;
    const res = o.value - fit;
    out.push({
      level_a: o.level_a,
      level_b: o.level_b,
      replicate: o.replicate,
      observed: o.value,
      fitted: fit,
      residual: res,
      standardized: result.mse > 0 ? res / Math.sqrt(result.mse) : null,
    });
  }
  return { residuals: out, mse: result.mse };
}

export function rowOf(result: AnovaResult, source: AnovaTableRow["source"]): AnovaTableRow {
  return result.table.find((r) => r.source === source)!;
}

