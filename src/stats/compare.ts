import type { AnovaResult } from "./anova.ts";
import { holm, tTwoSided } from "./dist.ts";

export type PairwiseComparison = {
  factor: "A" | "B";
  level1: string;
  level2: string;
  difference: number;
  se: number;
  t: number;
  df: number;
  rawP: number | null;
  adjustedP: number | null;
  pNullReason?: "NO_VARIATION" | "PERFECT_FIT";
};

export type ComparisonFamily = {
  factor: "A" | "B";
  /** 检验族说明：同一因素内所有两两边际均值比较，使用共同 MSE。 */
  family: string;
  count: number;
  method: "pairwise-t-with-common-MSE + Holm";
  comparisons: PairwiseComparison[];
};

function buildFamily(
  factor: "A" | "B",
  marginals: { level: string; mean: number }[],
  perMeanRep: number,
  result: AnovaResult,
): ComparisonFamily {
  const errorRow = result.rows.find((r) => r.source === "error")!;
  const mse = errorRow.ms as number;
  const df = errorRow.df;
  const pairs: { l1: string; l2: string; diff: number }[] = [];
  for (let i = 0; i < marginals.length; i++) {
    for (let j = i + 1; j < marginals.length; j++) {
      pairs.push({
        l1: marginals[i].level,
        l2: marginals[j].level,
        diff: marginals[i].mean - marginals[j].mean,
      });
    }
  }
  const se = Math.sqrt((2 * mse) / perMeanRep);
  const comparisons: PairwiseComparison[] = pairs.map((p) => {
    if (mse === 0) {
      return {
        factor, level1: p.l1, level2: p.l2, difference: p.diff, se,
        t: p.diff === 0 ? 0 : p.diff > 0 ? Infinity : -Infinity,
        df, rawP: null, adjustedP: null,
        pNullReason: result.mseZero ?? undefined,
      };
    }
    return {
      factor, level1: p.l1, level2: p.l2, difference: p.diff, se,
      t: p.diff / se, df, rawP: 0, adjustedP: 0,
    };
  });

  if (mse > 0) {
    const raw = comparisons.map((c) => tTwoSided(c.t, df));
    const adj = holm(raw);
    comparisons.forEach((c, i) => {
      c.rawP = adj[i].raw;
      c.adjustedP = adj[i].adjusted;
    });
  }

  return {
    factor,
    family:
      factor === "A"
        ? `因素 A 全部 ${pairs.length} 个两两边际均值比较；零假设 H0: μ_i = μ_j；检验统计量服从 t(df=${df})，标准误由共同误差均方 MSE 计算；对该族实施 Holm 校正。`
        : `因素 B 全部 ${pairs.length} 个两两边际均值比较；零假设 H0: μ_i = μ_j；检验统计量服从 t(df=${df})，标准误由共同误差均方 MSE 计算；对该族实施 Holm 校正。`,
    count: pairs.length,
    method: "pairwise-t-with-common-MSE + Holm",
    comparisons,
  };
}

export function compareMarginals(result: AnovaResult): {
  familyA: ComparisonFamily;
  familyB: ComparisonFamily;
} {
  const b = result.bLevels.length;
  const a = result.aLevels.length;
  const n = result.replication;
  return {
    familyA: buildFamily("A", result.marginalA, b * n, result),
    familyB: buildFamily("B", result.marginalB, a * n, result),
  };
}
