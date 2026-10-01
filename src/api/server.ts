import { createServer, Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AppError } from "../types.ts";
import type { ApiError, ErrorCode } from "../types.ts";
import type { DB } from "../db/database.ts";
import { createDesign, freezeReport, getBatch, paginate } from "../services/repo.ts";
import type { Clock } from "../services/repo.ts";
import { checkBalance, interpret, residuals, runAnalysis } from "../services/analysis.ts";
import { factorSpec, intParam, observationsSpec, optInt, optStr, requireObject, str } from "./validation.ts";

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNBALANCED: 422,
  MISSING_CELL: 422,
  UNEQUAL_REPLICATES: 422,
  NON_FINITE: 422,
  INSUFFICIENT_REPLICATES: 422,
  INSUFFICIENT_ERROR_DF: 422,
  ZERO_MSE: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  FROZEN: 409,
  BAD_JSON: 400,
  INTERNAL: 500,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  const e =
    err instanceof AppError
      ? err
      : new AppError("INTERNAL", (err as Error).message ?? "internal error");
  if (e.code === "INTERNAL") console.error(e);
  const body: ApiError = { error: { code: e.code, message: e.message, details: e.details } };
  send(res, HTTP_STATUS[e.code], body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 5_000_000) throw new AppError("VALIDATION", "request body too large (max 5MB)");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return requireObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new AppError("BAD_JSON", "malformed JSON body");
  }
}

export interface AppServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export function buildServer(db: DB, clock: Clock): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    try {
      // ---- health ----
      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { status: "ok", time: clock.now().toISOString() });
      }

      // ---- designs ----
      if (req.method === "POST" && path === "/designs") {
        const body = await readJson(req);
        const id = createDesign(
          db,
          {
            name: str(body, "name"),
            factorA: factorSpec(body, "factorA"),
            factorB: factorSpec(body, "factorB"),
            observations: observationsSpec(body),
            supersedes: optInt(body, "supersedes"),
            idempotencyKey: optStr(body, "idempotency_key"),
          },
          clock,
        );
        return send(res, 201, { design_id: id });
      }

      if (req.method === "GET" && path === "/designs") {
        const page = intParam(url, "page", 1);
        const pageSize = intParam(url, "page_size", 20);
        const result = paginate(
          db,
          "SELECT id, name, version, factor_a_name, factor_b_name, supersedes, created_at FROM designs ORDER BY id",
          "SELECT COUNT(*) AS c FROM designs",
          [],
          page,
          pageSize,
        );
        return send(res, 200, result);
      }

      let m = path.match(/^\/designs\/(\d+)\/balance$/);
      if (req.method === "GET" && m) {
        return send(res, 200, checkBalance(db, Number(m[1])));
      }

      m = path.match(/^\/designs\/(\d+)\/analyses$/);
      if (req.method === "POST" && m) {
        const report = runAnalysis(db, Number(m[1]), clock);
        return send(res, 201, report);
      }

      m = path.match(/^\/designs\/(\d+)\/residuals$/);
      if (req.method === "GET" && m) {
        const page = intParam(url, "page", 1);
        const pageSize = intParam(url, "page_size", 50);
        const r = residuals(db, Number(m[1]));
        const start = (page - 1) * pageSize;
        return send(res, 200, {
          mse: r.mse,
          page,
          page_size: pageSize,
          total: r.residuals.length,
          items: r.residuals.slice(start, start + pageSize),
        });
      }

      m = path.match(/^\/designs\/(\d+)\/marginal-comparisons$/);
      if (req.method === "GET" && m) {
        const report = runAnalysis(db, Number(m[1]), clock);
        return send(res, 200, {
          family: "All pairwise marginal-mean differences are tested per factor separately, using the common pooled error term; Holm step-down adjustment is applied within each factor's family.",
          alpha: 0.05,
          family_size: report.result.familySize,
          factorA: {
            marginal_means: report.result.marginalMeansA,
            comparisons: report.result.comparisonsA,
          },
          factorB: {
            marginal_means: report.result.marginalMeansB,
            comparisons: report.result.comparisonsB,
          },
          caution:
            (interpret(report.result).cautions[0] as string | undefined) ??
            "No significant interaction; marginal comparisons are interpretable as main effects.",
        });
      }

      m = path.match(/^\/designs\/(\d+)\/observations$/);
      if (req.method === "GET" && m) {
        const page = intParam(url, "page", 1);
        const pageSize = intParam(url, "page_size", 50);
        const result = paginate(
          db,
          "SELECT id, level_a, level_b, replicate, value FROM observations WHERE design_id = ? ORDER BY level_a, level_b, replicate",
          "SELECT COUNT(*) AS c FROM observations WHERE design_id = ?",
          [Number(m[1])],
          page,
          pageSize,
        );
        return send(res, 200, result);
      }

      m = path.match(/^\/designs\/(\d+)\/batches$/);
      if (req.method === "GET" && m) {
        const page = intParam(url, "page", 1);
        const pageSize = intParam(url, "page_size", 20);
        const result = paginate(
          db,
          "SELECT id, design_id, design_version, created_at, status FROM analysis_batches WHERE design_id = ? ORDER BY id",
          "SELECT COUNT(*) AS c FROM analysis_batches WHERE design_id = ?",
          [Number(m[1])],
          page,
          pageSize,
        );
        return send(res, 200, result);
      }

      // ---- batches / frozen reports ----
      m = path.match(/^\/batches\/(\d+)$/);
      if (req.method === "GET" && m) {
        const batch = getBatch(db, Number(m[1]));
        return send(res, 200, { ...batch, result: JSON.parse(batch.result_json), result_json: undefined });
      }

      m = path.match(/^\/batches\/(\d+)\/freeze$/);
      if (req.method === "POST" && m) {
        const body = await readJson(req);
        const batchId = Number(m[1]);
        const batch = getBatch(db, batchId);
        const payload = { batch, frozen_result: JSON.parse(batch.result_json) };
        const report = freezeReport(
          db,
          batchId,
          JSON.stringify(payload),
          clock,
          optStr(body, "idempotency_key"),
        );
        return send(res, report.reused ? 200 : 201, {
          report_id: report.id,
          batch_id: report.batch_id,
          design_id: report.design_id,
          created_at: report.created_at,
          reused: report.reused,
        });
      }

      const fm = path.match(/^\/reports\/(\d+)$/);
      if (req.method === "GET" && fm) {
        const row = db.prepare("SELECT * FROM frozen_reports WHERE id = ?").get(Number(fm[1])) as
          | { id: number; batch_id: number; design_id: number; created_at: string; payload_json: string }
          | undefined;
        if (!row) throw new AppError("NOT_FOUND", `report ${fm[1]} not found`);
        return send(res, 200, { ...row, payload: JSON.parse(row.payload_json), payload_json: undefined });
      }

      if (req.method === "GET" && path === "/reports") {
        const page = intParam(url, "page", 1);
        const pageSize = intParam(url, "page_size", 20);
        const result = paginate(
          db,
          "SELECT id, batch_id, design_id, created_at FROM frozen_reports ORDER BY id",
          "SELECT COUNT(*) AS c FROM frozen_reports",
          [],
          page,
          pageSize,
        );
        return send(res, 200, result);
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `no route for ${req.method} ${path}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
  return server;
}

/** Bind to loopback only; port 0 lets the OS assign a free port. */
export function startServer(db: DB, clock: Clock, host = "127.0.0.1", port = 0): Promise<AppServer> {
  const server = buildServer(db, clock);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const assigned = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: assigned,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
