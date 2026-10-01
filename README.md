# Two-Way ANOVA Backend

A **local-only** backend for two-factor fixed-effects ANOVA on a **balanced full
factorial** design. It provides an HTTP API, a CLI, deterministic synthetic
data, and automated tests. There is **no web UI**, **no subject/random
allocation**, and **no external statistics service** — all distribution math is
implemented in this repository.

## Scope and rules

- Exactly **two fixed categorical factors**, full factorial, **balanced**:
  every A×B cell must exist and have the **same number n ≥ 2** of independent
  replicates.
- The engine decomposes `SS_Total = SS_A + SS_B + SS_AB + SS_Error`, computes
  degrees of freedom, mean squares, F statistics and **upper-tail p-values**.
- Rejected explicitly (no silent zero-filling):
  - missing cell → `MISSING_CELL`
  - unequal replicate counts → `UNEQUAL_REPLICATES`
  - non-finite observations → `NON_FINITE`
  - `n < 2` / error df `< 1` → `INSUFFICIENT_REPLICATES` / `INSUFFICIENT_ERROR_DF`
- When error MS is zero, ordinary F/p values are **withheld** (returned as
  `null` with a machine-readable `pNote`):
  - `ZERO_MSE_NO_VARIATION` — data are fully constant, nothing to test;
  - `ZERO_MSE_PERFECT_FIT` — between-cell structure exists but the saturated
    cell-mean model leaves no residual, so F = MS_effect / 0 is undefined.
- Reports include **cell means and interaction effects**. When A×B is
  significant, the report warns **not** to interpret marginal (main-effect)
  means as a uniform effect; inspect simple/cell effects instead.
- Results keep **statistical significance**, **effect size** (η² =
  SS_source/SS_total), and **model assumptions** separate. A threshold alone is
  never presented as the conclusion.

## Pairwise comparisons and multiplicity

Marginal-mean differences use the **common pooled error term**
(`SE = sqrt(2·MSE/reps)`). The testing family is **all pairwise contrasts within
each factor**, treated as two separate families. A **Holm step-down** adjustment
is applied within each family. Every comparison exposes both the **raw p** and
the **Holm p**, its rank and reject decision, so adjustments are traceable.

## Numerical methods and precision

- F upper tail: `P(F≥f) = I_{df2/(df2+df1·f)}(df2/2, df1/2)`.
- Two-sided Student t: `I_{df/(df+t²)}(df/2, 1/2)`.
- `I_x(a,b)` uses the regularized incomplete beta via the **Lentz continued
  fraction**; `log Γ` uses a 9-coefficient Lanczos approximation.
- Precision: `logΓ` relative error `< 1e-15`; continued-fraction tolerance
  `1e-15` (≤ 400 iterations); F/t probabilities accurate to roughly
  `1e-12–1e-14`. Small tails are evaluated directly (no cancellation), so
  p-values far into the tail stay representable.
- Sum-of-squares use **centered deviations** plus **Kahan compensated
  summation** for stability on extreme scales (see the `extreme` fixture).

## Requirements

- **Node.js ≥ 22.5** (developed on Node 25). Uses the built-in
  `node:sqlite` module and native TypeScript type-stripping — **no npm install
  and no native compilation required**.
- Windows / macOS / Linux. All data and temp files stay in `./data` inside the
  project. The API binds to `127.0.0.1` only on an OS-assigned free port.

## Commands

```powershell
# Automated tests (statistics, DB/transactions/version isolation, API, persistence)
npm test

# Repeatable end-to-end demonstration (deterministic clock + RNG seed)
npm run demo

# Start the local API (127.0.0.1, auto port; writes data/server.json)
npm start

# Stop the previously started project server (kills only its recorded PID)
npm run stop

# Remove generated data/ (only this project's files)
npm run clean
```

Optional environment variables: `ANOVA_DATA_DIR`, `ANOVA_DB`, `ANOVA_HOST`
(default `127.0.0.1`), `ANOVA_PORT` (default `0` = auto). If you override
`ANOVA_DATA_DIR` for the server, set the same value when running `npm run stop`.

## CLI

```powershell
npm run cli -- import   --file examples/design.example.json [--supersedes N] [--idem-key K]
npm run cli -- seed     --scenario main|interaction|constant|extreme [--n 3] [--seed 12345]
npm run cli -- balance  --design ID
npm run cli -- analyze  --design ID
npm run cli -- compare  --design ID
npm run cli -- residuals --design ID
npm run cli -- freeze   --batch ID [--idem-key K]
npm run cli -- export   --batch ID [--out file.json]
```

State-changing commands print **before/after** counts (e.g. designs and batches
before vs. after). `import` and `freeze` accept idempotency keys; repeating an
identical key returns the same record instead of creating a duplicate.

Input JSON shape (see `examples/design.example.json`):

```json
{
  "name": "study",
  "factorA": { "name": "Catalyst", "levels": ["C1", "C2"] },
  "factorB": { "name": "Temperature", "levels": ["T1", "T2", "T3"] },
  "observations": [
    { "level_a": "C1", "level_b": "T1", "replicate": 1, "value": 54.2 }
  ]
}
```

## HTTP API

All requests/responses are JSON. List endpoints accept `?page=` and
`?page_size=` (page size capped at 200) and return
`{ items, page, page_size, total, total_pages }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + injected server time |
| POST | `/designs` | import a design (body validated; optional `idempotency_key`, `supersedes`) |
| GET | `/designs?page=&page_size=` | paginated designs |
| GET | `/designs/{id}/balance` | balance/structure report |
| GET | `/designs/{id}/observations` | paginated observations |
| POST | `/designs/{id}/analyses` | run ANOVA, create an analysis batch |
| GET | `/designs/{id}/batches` | batches for a design (paginated) |
| GET | `/designs/{id}/residuals` | residuals from the cell-mean fit (paginated) |
| GET | `/designs/{id}/marginal-comparisons` | pairwise marginal means, raw + Holm p |
| GET | `/batches/{id}` | stored analysis result |
| POST | `/batches/{id}/freeze` | freeze an immutable report (idempotent) |
| GET | `/reports?page=&page_size=` | frozen report index (paginated) |
| GET | `/reports/{id}` | frozen report payload |

### Error codes

Errors return `{ "error": { "code", "message", "details?" } }`:
`VALIDATION`, `BAD_JSON`, `MISSING_CELL`, `UNEQUAL_REPLICATES`, `NON_FINITE`,
`INSUFFICIENT_REPLICATES`, `INSUFFICIENT_ERROR_DF`, `ZERO_MSE`, `NOT_FOUND`,
`CONFLICT`, `FROZEN`, `UNBALANCED`, `INTERNAL`.

Example:

```powershell
$port = (Get-Content data/server.json | ConvertFrom-Json).port
Invoke-RestMethod "http://127.0.0.1:$port/designs" -Method Post `
  -ContentType 'application/json' -InFile examples/design.example.json
```

## Data model and migrations

SQLite tables (see `src/db/migrations.ts`): `designs` (with `version` and
optional `supersedes`), `factor_levels`, `observations`, `analysis_batches`,
and immutable `frozen_reports`. Migrations use `CREATE TABLE IF NOT EXISTS` and
an idempotent `schema_version` record, so re-running them on an existing
database is a safe no-op (covered by the persistence test). Re-importing a
revised dataset with `supersedes` creates a new **versioned** design without
touching prior data; analysis batches pin the design version they ran against.

## Project layout

```
src/
  stats/dist.ts        incomplete beta, F/t distributions
  stats/anova.ts       balanced two-way ANOVA engine
  db/                  SQLite connection + idempotent migrations
  services/            repository, analysis orchestration, synthetic data
  api/                 HTTP validation + server (loopback only)
  cli.ts  server.ts
tests/                 node:test suites
scripts/               demo, stop, clean
examples/              sample import file
```

## Tests

`npm test` runs 23 checks covering: hand-computed SS decomposition and degrees
of freedom, SS additivity, invariance to level reordering, pure-main-effect and
pure-interaction fixtures, fully-constant data, replicate-count errors,
extreme-scale numerical stability, known F/t distribution critical values,
Holm monotonicity and traceability, transaction rollback, design-version
isolation, API validation/error codes/pagination/idempotency, and persistence
across a close/reopen cycle.
