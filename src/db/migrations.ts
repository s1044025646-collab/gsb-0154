// Idempotent, repeatable migrations. Each statement is guarded so re-running
// `migrate` on an existing database is a safe no-op.

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      factor_a_name TEXT NOT NULL,
      factor_b_name TEXT NOT NULL,
      supersedes INTEGER,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS factor_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id),
      factor TEXT NOT NULL CHECK (factor IN ('A','B')),
      position INTEGER NOT NULL,
      label TEXT NOT NULL,
      UNIQUE (design_id, factor, label),
      UNIQUE (design_id, factor, position)
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id),
      level_a TEXT NOT NULL,
      level_b TEXT NOT NULL,
      replicate INTEGER NOT NULL,
      value REAL NOT NULL,
      client_ref TEXT,
      UNIQUE (design_id, level_a, level_b, replicate),
      UNIQUE (design_id, client_ref)
    );

    CREATE TABLE IF NOT EXISTS analysis_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id),
      design_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      result_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS frozen_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL UNIQUE REFERENCES analysis_batches(id),
      design_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      idempotency_key TEXT,
      payload_json TEXT NOT NULL,
      UNIQUE (idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_obs_design ON observations(design_id);
    CREATE INDEX IF NOT EXISTS idx_batches_design ON analysis_batches(design_id);
    CREATE INDEX IF NOT EXISTS idx_frozen_design ON frozen_reports(design_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_designs_idem ON designs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
];
