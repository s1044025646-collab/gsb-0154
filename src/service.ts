import { createHash } from "node:crypto";
import type { Store } from "./db.ts";
import { anova2, AnovaValidationError } from "./stats/anova.ts";
import { compareMarginals } from "./stats/compare.ts";

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function runAnalysis(store: Store, designId: string) {
  const design = store.getDesign(designId);
  if (!design) throw new ApiError(404, "DESIGN_NOT_FOUND", `设计不存在: ${designId}`);
  const batchId = store.createBatch(designId);
  try {
    const result = anova2({
      aLevels: design.a_levels ?? design.aLevels,
      bLevels: design.b_levels ?? design.bLevels,
      observations: design.observations.map((o: any) => ({
        aLevel: o.aLevel,
        bLevel: o.bLevel,
        value: o.value,
      })),
    });
    const compare = compareMarginals(result);
    store.saveAnalysisSuccess(batchId, result, compare);
    return { batchId, result, compare, designVersion: design.version, designName: design.name };
  } catch (err) {
    if (err instanceof AnovaValidationError) {
      store.saveAnalysisFailure(batchId, err.code, err.message);
      throw new ApiError(422, err.code, err.message, err.detail);
    }
    store.saveAnalysisFailure(batchId, "INTERNAL", (err as Error).message);
    throw err;
  }
}

export function buildReportPayload(store: Store, batchId: string) {
  const batch = store.getBatch(batchId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", `批次不存在: ${batchId}`);
  if (batch.status !== "analyzed" || !batch.analysis) {
    throw new ApiError(409, "BATCH_NOT_ANALYZED", "批次未成功分析，无法冻结");
  }
  const design = store.getDesign(batch.design_id)!;
  return {
    reportKind: "two-way-fixed-balanced-anova",
    frozenAt: store.nowIso(),
    design: {
      id: design.id,
      name: design.name,
      version: design.version,
      factorA: design.factor_a,
      factorB: design.factor_b,
      aLevels: design.aLevels,
      bLevels: design.bLevels,
      replication: batch.analysis.result.replication,
    },
    anovaTable: batch.analysis.result.rows,
    cellMeans: batch.analysis.result.cellMeans,
    marginalMeans: {
      A: batch.analysis.result.marginalA,
      B: batch.analysis.result.marginalB,
    },
    pairwiseComparisons: batch.analysis.compare,
    interpretation: interpretation(batch.analysis.result),
    assumptions: [
      "独立观测（格子内重复相互独立）",
      "格子内残差近似正态",
      "各格子方差齐性",
      "两个因素为固定效应，设计平衡（等重复）",
    ],
  };
}

export function interpretation(result: ReturnType<typeof anova2>) {
  const find = (s: string) => result.rows.find((r) => r.source === s)!;
  const sig = (s: string) => {
    const row = find(s);
    if (row.p === null) return "不可计算普通 p 值（误差均方为 0）";
    return row.p < 0.05 ? "在 0.05 水平显著" : "在 0.05 水平不显著";
  };
  const abRow = find("AB");
  const lines = [
    `因素 A：${sig("A")}；η²=${fmt(find("A").etaSquared)}，partial η²=${fmt(find("A").partialEtaSquared)}。`,
    `因素 B：${sig("B")}；η²=${fmt(find("B").etaSquared)}，partial η²=${fmt(find("B").partialEtaSquared)}。`,
    `交互 AB：${sig("AB")}；η²=${fmt(abRow.etaSquared)}，partial η²=${fmt(abRow.partialEtaSquared)}。`,
  ];
  if (abRow.p !== null && abRow.p < 0.05) {
    lines.push("交互显著：边际均值可能随另一因素水平改变方向，不能仅凭边际均值宣称统一主效应。");
  }
  lines.push(
    "p 值衡量与数据相容程度，不代表效应的实际重要性；效应大小（η²）与模型假设需单独评估。阈值仅用于决策约定，不能替代解释。",
  );
  return lines;
}

function fmt(x: number | null) {
  return x === null ? "NA" : x.toPrecision(4);
}

export function freezeReport(store: Store, batchId: string) {
  const payload = buildReportPayload(store, batchId);
  const sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return store.freezeReport(batchId, payload, sha256);
}
