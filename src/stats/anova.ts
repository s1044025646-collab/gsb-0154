import { AppError } from "../types.ts";
import type { AnovaResult, AnovaTableRow, CellStat, Factor, MarginalComparison, PNote } from "../types.ts";
import { fSurvival, tTwoSided } from "./dist.ts";

// Kahan compensated summation for numerical stability under extreme scales.
function kahan(xs: number[]): number {
  let sum = 0;
  let comp = 0;
  for (const x of xs) {
    const y = x - comp;
    const t = sum + y;
    comp = t - sum - y;
    sum = t;
  }
  return sum;
}

const REL_ZERO = 1e-12;

/**
 * Validate a complete balanced two-way cell matrix.
 * Throws AppError with an explicit code on the first structural problem.
 */
export function validateMatrix(matrix: number[][][]): { a: number; b: number; n: number } {
  if (!Array.isArray(matrix) || matrix.length === 0 || !Array.isArray(matrix[0]) || matrix[0].length === 0) {
    throw new AppError("VALIDATION", "matrix must be a non-empty 3D array of cells");
  }
  const a = matrix.length;
  const b = matrix[0].length;
  for (let i = 0; i < a; i++) {
    if (!Array.isArray(matrix[i]) || matrix[i]!.length !== b) {
      throw new AppError("MISSING_CELL", `factor A level index ${i} is missing cells (grid must be complete)`);
    }
  }
  let n = -1;
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const cell = matrix[i]![j]!;
      if (!Array.isArray(cell) || cell.length === 0) {
        throw new AppError("MISSING_CELL", `cell (${i},${j}) has no observations`);
      }
      for (const v of cell) {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new AppError("NON_FINITE", `cell (${i},${j}) contains a non-finite observation`);
        }
      }
      if (n === -1) n = cell.length;
      else if (cell.length !== n) {
        throw new AppError(
          "UNEQUAL_REPLICATES",
          `cell (${i},${j}) has ${cell.length} replicates but expected ${n}`,
          { expected: n, found: cell.length, cell: [i, j] },
        );
      }
    }
  }
  if (n < 2) {
    throw new AppError("INSUFFICIENT_REPLICATES", `each cell needs >= 2 independent replicates, found n=${n}`);
  }
  const errorDf = a * b * (n - 1);
  if (errorDf < 1) {
    throw new AppError("INSUFFICIENT_ERROR_DF", `error degrees of freedom = ${errorDf}; need at least 1`);
  }
  return { a, b, n };
}

function isZeroSse(ss: number, scale: number): boolean {
  return ss <= REL_ZERO * Math.max(1, scale * scale);
}

/** Pairwise comparisons of marginal means using the pooled error term, Holm-adjusted. */
function compareFactor(
  factor: Factor,
  marginals: { mean: number }[],
  nPerCell: number,
  otherLevelCount: number,
  mse: number,
  errorDf: number,
  mseZeroNote: PNote | null,
): { comparisons: MarginalComparison[]; familySize: number } {
  const k = factor.levels.length;
  const pairs: MarginalComparison[] = [];
  // Each marginal mean averages k-other-level * n observations.
  const reps = otherLevelCount * nPerCell;
  const se = Math.sqrt((2 * mse) / reps);
  let rank = 0;
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const diff = marginals[i]!.mean - marginals[j]!.mean;
      let t: number | null = null;
      let rawP: number | null = null;
      let note: PNote | null = null;
      if (mseZeroNote) {
        note = mseZeroNote;
      } else {
        t = diff / se;
        rawP = tTwoSided(t, errorDf);
      }
      pairs.push({
        factor: factor.key,
        reference: factor.levels[i]!,
        comparison: factor.levels[j]!,
        difference: diff,
        se,
        t,
        rawP,
        holmP: null,
        rank: rank++,
        rejected: null,
        note,
      });
    }
  }
  // Holm step-down within THIS factor's family.
  const m = pairs.length;
  const valid = pairs.filter((p) => p.rawP !== null);
  const order = valid
    .map((p, idx) => ({ p: p.rawP!, idx: pairs.indexOf(p), orig: idx }))
    .sort((x, y) => x.p - y.p);
  let running = 0;
  let prev = 0;
  for (let pos = 0; pos < order.length; pos++) {
    const adjusted = Math.min(1, (m - pos) * order[pos]!.p);
    running = Math.max(prev, adjusted);
    prev = running;
    const target = pairs[order[pos]!.idx]!;
    target.holmP = running;
    target.rank = pos;
    target.rejected = running < 0.05;
  }
  return { comparisons: pairs, familySize: m };
}

/**
 * Core two-way fixed-effects ANOVA for a balanced full factorial design.
 * Does not know about the database; pure function of factors + cell matrix.
 */
export function anova(factorA: Factor, factorB: Factor, matrix: number[][][]): AnovaResult {
  const { a, b, n } = validateMatrix(matrix);

  const total: number[] = [];
  const cellMean: number[][] = [];
  const cellSums: number[][] = [];
  for (let i = 0; i < a; i++) {
    cellMean.push(new Array(b).fill(0));
    cellSums.push(new Array(b).fill(0));
    for (let j = 0; j < b; j++) {
      const vals = matrix[i]![j]!;
      const s = kahan(vals);
      cellSums[i]![j] = s;
      cellMean[i]![j] = s / n;
      total.push(...vals);
    }
  }

  const N = a * b * n;
  const grandMean = kahan(total) / N;

  // Sums of squares computed on centered deviations for stability.
  let ssTotal = 0;
  let ssError = 0;
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      for (const v of matrix[i]![j]!) {
        const dt = v - grandMean;
        ssTotal += dt * dt;
        const de = v - cellMean[i]![j]!;
        ssError += de * de;
      }
    }
  }

  const rowMeans: number[] = [];
  const colMeans: number[] = [];
  for (let i = 0; i < a; i++) {
    let s = 0;
    for (let j = 0; j < b; j++) s += cellMean[i]![j]!;
    rowMeans.push(s / b);
  }
  for (let j = 0; j < b; j++) {
    let s = 0;
    for (let i = 0; i < a; i++) s += cellMean[i]![j]!;
    colMeans.push(s / a);
  }

  let ssA = 0;
  for (let i = 0; i < a; i++) ssA += (rowMeans[i]! - grandMean) ** 2;
  ssA *= b * n;

  let ssB = 0;
  for (let j = 0; j < b; j++) ssB += (colMeans[j]! - grandMean) ** 2;
  ssB *= a * n;

  let ssAB = 0;
  const cells: CellStat[] = [];
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const interaction = cellMean[i]![j]! - grandMean -
        (rowMeans[i]! - grandMean) - (colMeans[j]! - grandMean);
      ssAB += interaction * interaction;
      cells.push({
        level_a: factorA.levels[i]!,
        level_b: factorB.levels[j]!,
        n,
        mean: cellMean[i]![j]!,
        interaction,
      });
    }
  }
  ssAB *= n;

  const dfA = a - 1;
  const dfB = b - 1;
  const dfAB = (a - 1) * (b - 1);
  const dfE = a * b * (n - 1);
  const dfT = N - 1;

  const mse = ssError / dfE;
  const scale = Math.max(1, Math.abs(grandMean));
  const zeroMse = isZeroSse(ssError, scale);
  // Distinguish a fully constant dataset (no variation at all) from a model
  // that fits every cell mean exactly but leaves no residual to test against.
  const noVariationAtAll = zeroMse && isZeroSse(ssA + ssB + ssAB, scale);
  const mseNote: PNote | null = zeroMse
    ? noVariationAtAll
      ? "ZERO_MSE_NO_VARIATION"
      : "ZERO_MSE_PERFECT_FIT"
    : null;

  const row = (
    source: AnovaTableRow["source"],
    label: string,
    ss: number,
    df: number,
  ): AnovaTableRow => {
    const ms = ss / df;
    if (zeroMse) {
      return { source, label, ss, df, ms, f: null, p: null, pNote: mseNote };
    }
    const f = ms / mse;
    const df1 =
      source === "A" ? dfA : source === "B" ? dfB : source === "AB" ? dfAB : df;
    return { source, label, ss, df, ms, f, p: fSurvival(f, df1, dfE), pNote: null };
  };

  const table: AnovaTableRow[] = [
    row("A", `Factor A: ${factorA.name}`, ssA, dfA),
    row("B", `Factor B: ${factorB.name}`, ssB, dfB),
    row("AB", `A x B interaction`, ssAB, dfAB),
    { source: "Error", label: "Error (within-cell)", ss: ssError, df: dfE, ms: mse, f: null, p: null, pNote: mseNote },
    { source: "Total", label: "Total", ss: ssTotal, df: dfT, ms: null, f: null, p: null, pNote: null },
  ];

  const marginalMeansA = factorA.levels.map((level, i) => ({
    level,
    mean: rowMeans[i]!,
  }));
  const marginalMeansB = factorB.levels.map((level, j) => ({
    level,
    mean: colMeans[j]!,
  }));

  const cmpA = compareFactor(factorA, rowMeans.map((mean) => ({ mean })), n, b, mse, dfE, mseNote);
  const cmpB = compareFactor(factorB, colMeans.map((mean) => ({ mean })), n, a, mse, dfE, mseNote);

  return {
    table,
    cells,
    grandMean,
    marginalMeansA,
    marginalMeansB,
    comparisonsA: cmpA.comparisons,
    comparisonsB: cmpB.comparisons,
    familySize: { A: cmpA.familySize, B: cmpB.familySize },
    mse,
    errorDf: dfE,
    nPerCell: n,
  };
}
