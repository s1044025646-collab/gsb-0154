import { fUpperTail } from "./dist.ts";

export type Observation = {
  aLevel: string;
  bLevel: string;
  value: number;
};

export type AnovaInput = {
  aLevels: string[];
  bLevels: string[];
  observations: Observation[];
};

export type AnovaErrorCode =
  | "EMPTY_LEVELS"
  | "DUP_LEVEL"
  | "NON_FINITE_OBS"
  | "UNKNOWN_LEVEL"
  | "MISSING_CELL"
  | "UNEQUAL_REPLICATION"
  | "INSUFFICIENT_REPLICATION"
  | "INSUFFICIENT_ERROR_DF";

export class AnovaValidationError extends Error {
  code: AnovaErrorCode;
  detail?: unknown;
  constructor(code: AnovaErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "AnovaValidationError";
    this.code = code;
    this.detail = detail;
  }
}

export type AnovaRow = {
  source: "A" | "B" | "AB" | "error" | "total";
  ss: number;
  df: number;
  ms: number | null;
  f: number | null;
  p: number | null;
  /** 当 MSE=0 时普通 p 值被刻意置空，这里给出原因。 */
  pNullReason?: "NO_VARIATION" | "PERFECT_FIT";
  etaSquared: number | null;
  partialEtaSquared: number | null;
};

export type CellStat = {
  aLevel: string;
  bLevel: string;
  n: number;
  mean: number;
  /** 交互效应 = 格子均值 - A 边际均值 - B 边际均值 + 总均值。 */
  interactionEffect: number;
};

export type Residual = Observation & {
  predicted: number;
  residual: number;
};

export type AnovaResult = {
  aLevels: string[];
  bLevels: string[];
  replication: number;
  grandMean: number;
  cellMeans: CellStat[];
  marginalA: { level: string; mean: number }[];
  marginalB: { level: string; mean: number }[];
  rows: AnovaRow[];
  residuals: Residual[];
  mseZero: null | "NO_VARIATION" | "PERFECT_FIT";
  ssTotal: number;
  notes: string[];
};

/** 仅校验平衡与观测质量，返回按格子分组的值（保持输入水平顺序）。 */
export function groupBalanced(input: AnovaInput): {
  cells: number[][][];
  replication: number;
} {
  const { aLevels, bLevels, observations } = input;
  if (aLevels.length < 2 || bLevels.length < 2) {
    throw new AnovaValidationError(
      "EMPTY_LEVELS",
      "两个因素都必须至少有两个水平",
    );
  }
  if (new Set(aLevels).size !== aLevels.length ||
      new Set(bLevels).size !== bLevels.length) {
    throw new AnovaValidationError("DUP_LEVEL", "同一因素内水平名称不得重复");
  }
  const aIndex = new Map(aLevels.map((l, i) => [l, i]));
  const bIndex = new Map(bLevels.map((l, i) => [l, i]));
  const a = aLevels.length;
  const b = bLevels.length;
  const cells: number[][][] = Array.from({ length: a }, () =>
    Array.from({ length: b }, () => [])
  );
  for (const obs of observations) {
    if (!Number.isFinite(obs.value)) {
      throw new AnovaValidationError(
        "NON_FINITE_OBS",
        `观测值必须为有限数值：A=${obs.aLevel} B=${obs.bLevel}`,
        obs,
      );
    }
    const ai = aIndex.get(obs.aLevel);
    const bi = bIndex.get(obs.bLevel);
    if (ai === undefined || bi === undefined) {
      throw new AnovaValidationError(
        "UNKNOWN_LEVEL",
        `观测引用了未登记的水平：A=${obs.aLevel} B=${obs.bLevel}`,
        obs,
      );
    }
    cells[ai][bi].push(obs.value);
  }

  let replication = -1;
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const n = cells[i][j].length;
      if (n === 0) {
        throw new AnovaValidationError(
          "MISSING_CELL",
          `缺失格子：A=${aLevels[i]} B=${bLevels[j]}（禁止补零）`,
          { aLevel: aLevels[i], bLevel: bLevels[j] },
        );
      }
      if (replication === -1) replication = n;
      else if (n !== replication) {
        throw new AnovaValidationError(
          "UNEQUAL_REPLICATION",
          `不等重复数：期望每格 ${replication}，但 A=${aLevels[i]} B=${bLevels[j]} 有 ${n}`,
          { expected: replication, actual: n, aLevel: aLevels[i], bLevel: bLevels[j] },
        );
      }
    }
  }
  if (replication < 2) {
    throw new AnovaValidationError(
      "INSUFFICIENT_REPLICATION",
      "每个格子至少需要两个独立重复",
      { replication },
    );
  }
  const dfError = a * b * (replication - 1);
  if (dfError <= 0) {
    throw new AnovaValidationError(
      "INSUFFICIENT_ERROR_DF",
      "误差自由度不足，无法估计误差均方",
      { dfError },
    );
  }
  return { cells, replication };
}

function sum(xs: number[]): number {
  let s = 0;
  let c = 0;
  for (const x of xs) {
    const y = x - c;
    const t = s + y;
    c = t - s - y;
    s = t;
  }
  return s;
}

/**
 * 平衡双因素固定效应全因子方差分析。
 * 分解：SS_total = SS_A + SS_B + SS_AB + SS_error。
 */
export function anova2(input: AnovaInput): AnovaResult {
  const { aLevels, bLevels, observations } = input;
  const { cells, replication } = groupBalanced(input);
  const a = aLevels.length;
  const b = bLevels.length;
  const n = replication;
  const N = a * b * n;

  // 极端尺度下使用中心化数据计算平方和，避免大数相减丢失精度。
  const rawValues = observations.map((o) => o.value);
  const center = rawValues[0];
  const totalShifted = sum(rawValues.map((v) => v - center));
  const grandMean = center + totalShifted / N;

  const cellMean: number[][] = Array.from({ length: a }, () => new Array(b));
  const aSum = new Array<number>(a).fill(0);
  const bSum = new Array<number>(b).fill(0);
  const errSq: number[] = [];
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const vals = cells[i][j];
      const m = sum(vals) / n;
      cellMean[i][j] = m;
      aSum[i] += sum(vals);
      bSum[j] += sum(vals);
      for (const v of vals) errSq.push((v - m) * (v - m));
    }
  }
  const margA = aSum.map((s) => s / (b * n));
  const margB = bSum.map((s) => s / (a * n));

  const ssA = sum(margA.map((m) => b * n * (m - grandMean) ** 2));
  const ssB = sum(margB.map((m) => a * n * (m - grandMean) ** 2));
  const abSq: number[] = [];
  const interaction: number[][] = Array.from({ length: a }, () => new Array(b));
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const e = cellMean[i][j] - margA[i] - margB[j] + grandMean;
      interaction[i][j] = e;
      abSq.push(n * e * e);
    }
  }
  const ssAB = sum(abSq);
  const ssError = sum(errSq);
  const ssTotal = sum(rawValues.map((v) => (v - grandMean) ** 2));

  const dfA = a - 1;
  const dfB = b - 1;
  const dfAB = (a - 1) * (b - 1);
  const dfError = a * b * (n - 1);
  const dfTotal = N - 1;

  const msA = ssA / dfA;
  const msB = ssB / dfB;
  const msAB = ssAB / dfAB;
  const mse = ssError / dfError;

  const notes: string[] = [];
  let mseZero: null | "NO_VARIATION" | "PERFECT_FIT" = null;
  if (mse === 0) {
    const modelSS = ssA + ssB + ssAB;
    mseZero = modelSS === 0 ? "NO_VARIATION" : "PERFECT_FIT";
    notes.push(
      mseZero === "NO_VARIATION"
        ? "误差均方为 0 且模型平方和为 0：所有观测相同，无变异可检验，不报告普通 F 与 p 值。"
        : "误差均方为 0 但模型平方和 > 0：饱和/完全拟合，F 在经典固定效应模型下发散，不报告普通 p 值。",
    );
  }

  const effectRow = (
    source: "A" | "B" | "AB",
    ss: number,
    df: number,
    ms: number,
  ): AnovaRow => {
    const eta = ssTotal > 0 ? ss / ssTotal : null;
    if (mse === 0) {
      return {
        source, ss, df, ms,
        f: ms > 0 ? Infinity : null,
        p: null,
        pNullReason: mseZero ?? undefined,
        etaSquared: eta,
        partialEtaSquared: ss + ssError > 0 ? ss / (ss + ssError) : null,
      };
    }
    const f = ms / mse;
    const p = fUpperTail(f, df, dfError);
    return {
      source, ss, df, ms, f, p,
      etaSquared: eta,
      partialEtaSquared: ss / (ss + ssError),
    };
  };

  const rows: AnovaRow[] = [
    effectRow("A", ssA, dfA, msA),
    effectRow("B", ssB, dfB, msB),
    effectRow("AB", ssAB, dfAB, msAB),
    {
      source: "error", ss: ssError, df: dfError, ms: mse,
      f: null, p: null, etaSquared: null, partialEtaSquared: null,
    },
    {
      source: "total", ss: ssTotal, df: dfTotal, ms: null,
      f: null, p: null, etaSquared: null, partialEtaSquared: null,
    },
  ];

  const cellMeans: CellStat[] = [];
  const residuals: Residual[] = [];
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      cellMeans.push({
        aLevel: aLevels[i],
        bLevel: bLevels[j],
        n,
        mean: cellMean[i][j],
        interactionEffect: interaction[i][j],
      });
    }
  }
  for (const obs of observations) {
    const i = aLevels.indexOf(obs.aLevel);
    const j = bLevels.indexOf(obs.bLevel);
    residuals.push({
      ...obs,
      predicted: cellMean[i][j],
      residual: obs.value - cellMean[i][j],
    });
  }

  const abRow = rows[2];
  if (abRow.p !== null && abRow.p < 0.05) {
    notes.push(
      "交互作用在 0.05 水平显著：不得仅凭边际均值宣称统一主效应，应结合格子均值与交互效应解释。",
    );
  }

  return {
    aLevels,
    bLevels,
    replication,
    grandMean,
    cellMeans,
    marginalA: aLevels.map((l, i) => ({ level: l, mean: margA[i] })),
    marginalB: bLevels.map((l, j) => ({ level: l, mean: margB[j] })),
    rows,
    residuals,
    mseZero,
    ssTotal,
    notes,
  };
}
