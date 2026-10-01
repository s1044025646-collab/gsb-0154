import { AppError } from "../types.ts";
import type { DesignData, Factor, FactorKey } from "../types.ts";
import type { DB } from "../db/database.ts";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(e?.message ?? "");
}

export interface CreateDesignInput {
  name: string;
  factorA: { name: string; levels: string[] };
  factorB: { name: string; levels: string[] };
  observations: { level_a: string; level_b: string; replicate: number; value: number; client_ref?: string }[];
  supersedes?: number;
  idempotencyKey?: string;
}

function cleanLevels(levels: string[], factor: FactorKey): string[] {
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new AppError("VALIDATION", `factor ${factor} needs at least 2 levels`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of levels) {
    const label = String(raw).trim();
    if (!label) throw new AppError("VALIDATION", `factor ${factor} has an empty level label`);
    if (seen.has(label)) throw new AppError("VALIDATION", `factor ${factor} duplicate level ${label}`);
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Insert a design and its observations in a single transaction. */
export function createDesign(db: DB, input: CreateDesignInput, clock: Clock = systemClock): number {
  if (!input.name || !input.name.trim()) throw new AppError("VALIDATION", "name is required");
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new AppError("VALIDATION", "observations are required");
  }
  const levelsA = cleanLevels(input.factorA.levels, "A");
  const levelsB = cleanLevels(input.factorB.levels, "B");
  if (!input.factorA.name?.trim() || !input.factorB.name?.trim()) {
    throw new AppError("VALIDATION", "both factor names are required");
  }

  let version = 1;
  if (input.supersedes !== undefined) {
    const prev = db.prepare("SELECT version FROM designs WHERE id = ?").get(input.supersedes) as
      | { version: number }
      | undefined;
    if (!prev) throw new AppError("NOT_FOUND", `superseded design ${input.supersedes} not found`);
    version = prev.version + 1;
  }

  if (input.idempotencyKey) {
    const existing = db.prepare("SELECT id FROM designs WHERE idempotency_key = ?").get(input.idempotencyKey) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;
  }

  const ts = clock.now().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const info = db
      .prepare(
        `INSERT INTO designs (name, version, factor_a_name, factor_b_name, supersedes, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name.trim(), version, input.factorA.name.trim(), input.factorB.name.trim(), input.supersedes ?? null, input.idempotencyKey ?? null, ts);
    const designId = Number(info.lastInsertRowid);
    const insLevel = db.prepare(
      "INSERT INTO factor_levels (design_id, factor, position, label) VALUES (?, ?, ?, ?)",
    );
    levelsA.forEach((label, i) => insLevel.run(designId, "A", i, label));
    levelsB.forEach((label, j) => insLevel.run(designId, "B", j, label));

    const insObs = db.prepare(
      `INSERT INTO observations (design_id, level_a, level_b, replicate, value, client_ref)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const setA = new Set(levelsA);
    const setB = new Set(levelsB);
    for (const o of input.observations) {
      if (!setA.has(o.level_a)) throw new AppError("VALIDATION", `unknown level_a ${o.level_a}`);
      if (!setB.has(o.level_b)) throw new AppError("VALIDATION", `unknown level_b ${o.level_b}`);
      if (!Number.isInteger(o.replicate) || o.replicate < 1) {
        throw new AppError("VALIDATION", "replicate must be a positive integer");
      }
      if (typeof o.value !== "number" || !Number.isFinite(o.value)) {
        throw new AppError("NON_FINITE", "observation value must be finite");
      }
      insObs.run(designId, o.level_a, o.level_b, o.replicate, o.value, o.client_ref ?? null);
    }
    db.exec("COMMIT");
    return designId;
  } catch (err) {
    db.exec("ROLLBACK");
    if (err instanceof AppError) throw err;
    const code = (err as { code?: string }).code;
    if (isUniqueViolation(err)) {
      throw new AppError("CONFLICT", "duplicate cell/replicate or client_ref", (err as Error).message);
    }
    throw new AppError("INTERNAL", "failed to create design", (err as Error).message);
  }
}

export interface DesignMeta {
  id: number;
  name: string;
  version: number;
  factor_a_name: string;
  factor_b_name: string;
  supersedes: number | null;
  created_at: string;
}

export function getDesignMeta(db: DB, designId: number): DesignMeta {
  const row = db.prepare("SELECT * FROM designs WHERE id = ?").get(designId) as DesignMeta | undefined;
  if (!row) throw new AppError("NOT_FOUND", `design ${designId} not found`);
  return row;
}

function loadLevels(db: DB, designId: number, factor: FactorKey): string[] {
  const rows = db
    .prepare("SELECT label FROM factor_levels WHERE design_id = ? AND factor = ? ORDER BY position")
    .all(designId, factor) as { label: string }[];
  return rows.map((r) => r.label);
}

/** Load a design into the matrix shape expected by the stats engine. */
export function loadDesignData(db: DB, designId: number): DesignData {
  const meta = getDesignMeta(db, designId);
  const levelsA = loadLevels(db, designId, "A");
  const levelsB = loadLevels(db, designId, "B");
  const factorA: Factor = { key: "A", name: meta.factor_a_name, levels: levelsA };
  const factorB: Factor = { key: "B", name: meta.factor_b_name, levels: levelsB };
  const obs = db
    .prepare("SELECT level_a, level_b, replicate, value FROM observations WHERE design_id = ?")
    .all(designId) as { level_a: string; level_b: string; replicate: number; value: number }[];

  const matrix: number[][][] = levelsA.map(() => levelsB.map(() => [] as number[]));
  const ia = new Map(levelsA.map((l, i) => [l, i]));
  const ib = new Map(levelsB.map((l, j) => [l, j]));
  for (const o of obs) matrix[ia.get(o.level_a)!]![ib.get(o.level_b)!]!.push(o.value);

  return { designId, version: meta.version, factorA, factorB, matrix };
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(
  db: DB,
  sql: string,
  countSql: string,
  params: unknown[],
  page: number,
  pageSize: number,
): Page<T> {
  if (!Number.isInteger(page) || page < 1) throw new AppError("VALIDATION", "page must be >= 1");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new AppError("VALIDATION", "pageSize must be between 1 and 200");
  }
  const total = (db.prepare(countSql).get(...params) as { c: number }).c;
  const items = db
    .prepare(`${sql} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as T[];
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function createBatch(db: DB, designId: number, version: number, resultJson: string, clock: Clock): number {
  const info = db
    .prepare(
      `INSERT INTO analysis_batches (design_id, design_version, created_at, status, result_json)
       VALUES (?, ?, ?, 'completed', ?)`,
    )
    .run(designId, version, clock.now().toISOString(), resultJson);
  return Number(info.lastInsertRowid);
}

export function getBatch(db: DB, batchId: number) {
  const row = db.prepare("SELECT * FROM analysis_batches WHERE id = ?").get(batchId) as
    | { id: number; design_id: number; design_version: number; created_at: string; status: string; result_json: string }
    | undefined;
  if (!row) throw new AppError("NOT_FOUND", `batch ${batchId} not found`);
  return row;
}

export interface FrozenReport {
  id: number;
  batch_id: number;
  design_id: number;
  created_at: string;
  payload_json: string;
}

/** Freeze a batch report; idempotent on idempotencyKey and on batch identity. */
export function freezeReport(
  db: DB,
  batchId: number,
  payloadJson: string,
  clock: Clock,
  idempotencyKey?: string,
): FrozenReport & { reused: boolean } {
  if (idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM frozen_reports WHERE idempotency_key = ?")
      .get(idempotencyKey) as FrozenReport | undefined;
    if (existing) return { ...existing, reused: true };
  }
  const existingBatch = db.prepare("SELECT * FROM frozen_reports WHERE batch_id = ?").get(batchId) as
    | FrozenReport
    | undefined;
  if (existingBatch) return { ...existingBatch, reused: true };

  const batch = getBatch(db, batchId);
  try {
    const info = db
      .prepare(
        `INSERT INTO frozen_reports (batch_id, design_id, created_at, idempotency_key, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(batchId, batch.design_id, clock.now().toISOString(), idempotencyKey ?? null, payloadJson);
    const created = db.prepare("SELECT * FROM frozen_reports WHERE id = ?").get(
      Number(info.lastInsertRowid),
    ) as FrozenReport;
    return { ...created, reused: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError("CONFLICT", "report already frozen for this batch or key");
    }
    throw err;
  }
}


