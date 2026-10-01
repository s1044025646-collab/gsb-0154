import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

let instanceCounter = 0;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  response_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  factor_a TEXT NOT NULL,
  factor_b TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS levels (
  design_id TEXT NOT NULL,
  factor TEXT NOT NULL CHECK(factor IN ('A','B')),
  ordinal INTEGER NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (design_id, factor, ordinal)
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  a_label TEXT NOT NULL,
  b_label TEXT NOT NULL,
  value REAL NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_design ON observations(design_id);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('created','analyzed','failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  analyzed_at TEXT
);
CREATE TABLE IF NOT EXISTS analyses (
  batch_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  compare_json TEXT,
  analyzed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE,
  design_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);
`,
  },
];

export type Clock = () => Date;
export type IdGen = () => string;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

/** 幂等迁移：重复执行不报错，已应用版本跳过。 */
export function migrate(db: DatabaseSync): number {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
  const get = db.prepare("SELECT value FROM schema_meta WHERE key = 'user_version'");
  const row = get.get() as { value: string } | undefined;
  let current = row ? Number(row.value) : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare(
        `INSERT INTO schema_meta(key,value) VALUES('user_version',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ).run(String(m.version));
      db.exec("COMMIT");
      current = m.version;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return current;
}

export class Store {
  readonly id: IdGen;
  db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock = () => new Date(), idGen?: IdGen) {
    this.id = idGen ?? (() => `id_${++instanceCounter}_${randomUUID()}`);
    this.db = db;
    this.clock = clock;
  }

  nowIso() {
    return this.clock().toISOString();
  }

  /** 幂等：同一 key 直接返回首次响应，不重复执行。 */
  withIdempotency<T>(
    key: string | undefined,
    fn: () => T,
  ): { data: T; replayed: boolean } {
    if (!key) return { data: fn(), replayed: false };
    const existing = this.db
      .prepare("SELECT response_json FROM idempotency WHERE idempotency_key = ?")
      .get(key) as { response_json: string } | undefined;
    if (existing) return { data: JSON.parse(existing.response_json) as T, replayed: true };
    const data = fn();
    this.db
      .prepare(
        "INSERT INTO idempotency(idempotency_key, created_at, response_json) VALUES(?,?,?)",
      )
      .run(key, this.nowIso(), JSON.stringify(data));
    return { data, replayed: false };
  }

  createDesign(args: {
    name: string;
    factorA: string;
    factorB: string;
    aLevels: string[];
    bLevels: string[];
    observations: { aLevel: string; bLevel: string; value: number }[];
    supersedes?: string;
  }) {
    const tx = this.db.prepare(
      `INSERT INTO designs(id,name,factor_a,factor_b,version,supersedes,created_at)
       VALUES(?,?,?,?,
         COALESCE((SELECT MAX(version)+1 FROM designs WHERE name=?),1),
         ?,?)`,
    );
    const id = this.id();
    tx.run(
      id, args.name, args.factorA, args.factorB, args.name,
      args.supersedes ?? null, this.nowIso(),
    );
    this.db.prepare("SELECT * FROM designs WHERE id=?").get(id);
    const insLevel = this.db.prepare(
      "INSERT INTO levels(design_id,factor,ordinal,label) VALUES(?,?,?,?)",
    );
    args.aLevels.forEach((l, i) => insLevel.run(id, "A", i, l));
    args.bLevels.forEach((l, i) => insLevel.run(id, "B", i, l));
    const insObs = this.db.prepare(
      "INSERT INTO observations(id,design_id,a_label,b_label,value,seq,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    args.observations.forEach((o, seq) =>
      insObs.run(this.id(), id, o.aLevel, o.bLevel, o.value, seq, this.nowIso())
    );
    return this.getDesign(id)!;
  }

  getDesign(id: string) {
    const d = this.db.prepare("SELECT * FROM designs WHERE id=?").get(id) as any;
    if (!d) return undefined;
    return this.hydrateDesign(d);
  }

  getDesignByNameVersion(name: string, version: number) {
    const d = this.db
      .prepare("SELECT * FROM designs WHERE name=? AND version=?")
      .get(name, version) as any;
    return d ? this.hydrateDesign(d) : undefined;
  }

  private hydrateDesign(d: any) {
    const levels = this.db
      .prepare("SELECT factor,ordinal,label FROM levels WHERE design_id=? ORDER BY ordinal")
      .all(d.id) as any[];
    const obs = this.db
      .prepare(
        "SELECT id,a_label,b_label,value,seq FROM observations WHERE design_id=? ORDER BY seq",
      )
      .all(d.id) as any[];
    return {
      ...d,
      aLevels: levels.filter((l) => l.factor === "A").map((l) => l.label),
      bLevels: levels.filter((l) => l.factor === "B").map((l) => l.label),
      observations: obs.map((o) => ({
        id: o.id,
        aLevel: o.a_label,
        bLevel: o.b_label,
        value: o.value,
        seq: o.seq,
      })),
    };
  }

  listDesigns(limit: number, offset: number) {
    const rows = this.db
      .prepare("SELECT * FROM designs ORDER BY name, version LIMIT ? OFFSET ?")
      .all(limit, offset) as any[];
    const total = (this.db.prepare("SELECT COUNT(*) c FROM designs").get() as any).c;
    return { items: rows.map((d) => this.hydrateDesign(d)), total };
  }

  createBatch(designId: string) {
    const id = this.id();
    this.db
      .prepare("INSERT INTO batches(id,design_id,status,created_at) VALUES(?,?, 'created',?)")
      .run(id, designId, this.nowIso());
    return id;
  }

  getBatch(id: string) {
    const b = this.db.prepare("SELECT * FROM batches WHERE id=?").get(id) as any;
    if (!b) return undefined;
    const an = this.db.prepare("SELECT * FROM analyses WHERE batch_id=?").get(id) as any;
    return {
      ...b,
      analysis: an
        ? {
            result: JSON.parse(an.result_json),
            compare: an.compare_json ? JSON.parse(an.compare_json) : null,
            analyzedAt: an.analyzed_at,
          }
        : null,
    };
  }

  listBatches(designId: string | undefined, limit: number, offset: number) {
    const where = designId ? "WHERE design_id = ?" : "";
    const args = designId ? [designId, limit, offset] : [limit, offset];
    const rows = this.db
      .prepare(`SELECT * FROM batches ${where} ORDER BY created_at LIMIT ? OFFSET ?`)
      .all(...args) as any[];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) c FROM batches ${where}`)
        .get(...(designId ? [designId] : [])) as any
    ).c;
    return { items: rows, total };
  }

  saveAnalysisSuccess(
    batchId: string,
    result: unknown,
    compare: unknown,
  ) {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE batches SET status='analyzed', analyzed_at=?, error_code=NULL, error_message=NULL WHERE id=?`,
        )
        .run(this.nowIso(), batchId);
      this.db
        .prepare(
          `INSERT INTO analyses(batch_id,result_json,compare_json,analyzed_at)
           VALUES(?,?,?,?)
           ON CONFLICT(batch_id) DO UPDATE SET
             result_json=excluded.result_json,
             compare_json=excluded.compare_json,
             analyzed_at=excluded.analyzed_at`,
        )
        .run(batchId, JSON.stringify(result), JSON.stringify(compare), this.nowIso());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 失败路径在事务内落库；任何中途错误回滚，不留下半成品批次。 */
  saveAnalysisFailure(batchId: string, code: string, message: string) {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE batches SET status='failed', error_code=?, error_message=? WHERE id=?",
        )
        .run(code, message, batchId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  freezeReport(batchId: string, payload: unknown, sha256: string) {
    const batch = this.getBatch(batchId);
    if (!batch) throw new Error("BATCH_NOT_FOUND");
    if (batch.status !== "analyzed") throw new Error("BATCH_NOT_ANALYZED");
    const id = this.id();
    this.db
      .prepare(
        `INSERT INTO reports(id,batch_id,design_id,payload_json,sha256,frozen_at)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(id, batchId, batch.design_id, JSON.stringify(payload), sha256, this.nowIso());
    return this.getReport(id)!;
  }

  getReport(id: string) {
    const r = this.db.prepare("SELECT * FROM reports WHERE id=?").get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      batchId: r.batch_id,
      designId: r.design_id,
      sha256: r.sha256,
      frozenAt: r.frozen_at,
      payload: JSON.parse(r.payload_json),
    };
  }

  listReports(limit: number, offset: number) {
    const rows = this.db
      .prepare("SELECT id,batch_id,design_id,sha256,frozen_at FROM reports ORDER BY frozen_at LIMIT ? OFFSET ?")
      .all(limit, offset) as any[];
    const total = (this.db.prepare("SELECT COUNT(*) c FROM reports").get() as any).c;
    return {
      items: rows.map((r) => ({
        id: r.id, batchId: r.batch_id, designId: r.design_id,
        sha256: r.sha256, frozenAt: r.frozen_at,
      })),
      total,
    };
  }
}
