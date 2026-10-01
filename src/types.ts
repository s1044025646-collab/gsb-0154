// Shared domain types.

export type FactorKey = "A" | "B";

export interface Factor {
  key: FactorKey;
  name: string;
  levels: string[];
}

/** A single observation belonging to a design cell. */
export interface Observation {
  id: number;
  design_id: number;
  level_a: string;
  level_b: string;
  value: number;
  replicate: number;
}

/** Balanced design snapshot used by the statistics engine. */
export interface DesignData {
  designId: number;
  version: number;
  factorA: Factor;
  factorB: Factor;
  /** matrix[ai][bi] holds n replicate values. */
  matrix: number[][][];
}

export interface AnovaTableRow {
  source: "A" | "B" | "AB" | "Error" | "Total";
  label: string;
  ss: number;
  df: number;
  ms: number | null;
  f: number | null;
  p: number | null;
  /** Machine-readable reason a p-value was withheld. */
  pNote: PNote | null;
}

export type PNote =
  | "ZERO_MSE_NO_VARIATION"
  | "ZERO_MSE_PERFECT_FIT"
  | "INSUFFICIENT_ERROR_DF";

export interface CellStat {
  level_a: string;
  level_b: string;
  n: number;
  mean: number;
  /** Interaction effect: cell mean - grand - row effect - col effect. */
  interaction: number;
}

export interface MarginalComparison {
  factor: FactorKey;
  reference: string;
  comparison: string;
  difference: number;
  se: number;
  t: number | null;
  rawP: number | null;
  holmP: number | null;
  rank: number;
  rejected: boolean | null;
  note: PNote | null;
}

export interface AnovaResult {
  table: AnovaTableRow[];
  cells: CellStat[];
  grandMean: number;
  marginalMeansA: { level: string; mean: number }[];
  marginalMeansB: { level: string; mean: number }[];
  comparisonsA: MarginalComparison[];
  comparisonsB: MarginalComparison[];
  familySize: { A: number; B: number };
  mse: number;
  errorDf: number;
  nPerCell: number;
}

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export type ErrorCode =
  | "VALIDATION"
  | "UNBALANCED"
  | "MISSING_CELL"
  | "UNEQUAL_REPLICATES"
  | "NON_FINITE"
  | "INSUFFICIENT_REPLICATES"
  | "INSUFFICIENT_ERROR_DF"
  | "ZERO_MSE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FROZEN"
  | "BAD_JSON"
  | "INTERNAL";

export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
