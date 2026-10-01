import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Store } from "./db.ts";
import { generate } from "./synth.ts";
import type { SynthScenario } from "./synth.ts";
import { ApiError, freezeReport, runAnalysis } from "./service.ts";

type Json = unknown;

function send(res: ServerResponse, status: number, body: Json) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new ApiError(400, "INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireObject(body: any): Record<string, any> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_BODY", "请求体必须是 JSON 对象");
  }
  return body;
}

function requireString(body: Record<string, any>, key: string): string {
  if (typeof body[key] !== "string" || body[key].length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", `字段 ${key} 必须是非空字符串`, {
      field: key,
    });
  }
  return body[key];
}

function requireStringArray(body: Record<string, any>, key: string): string[] {
  const v = body[key];
  if (!Array.isArray(v) || v.length < 2 || !v.every((x) => typeof x === "string" && x.length)) {
    throw new ApiError(400, "VALIDATION_ERROR", `字段 ${key} 必须是至少 2 个非空字符串的数组`, {
      field: key,
    });
  }
  return v;
}

function requireObservations(body: Record<string, any>) {
  const v = body.observations;
  if (!Array.isArray(v) || v.length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "observations 必须是非空数组");
  }
  return v.map((o: any, idx: number) => {
    if (!o || typeof o !== "object") {
      throw new ApiError(400, "VALIDATION_ERROR", `observations[${idx}] 必须是对象`, { idx });
    }
    if (typeof o.aLevel !== "string" || typeof o.bLevel !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", `observations[${idx}] 需要字符串 aLevel/bLevel`, { idx });
    }
    if (typeof o.value !== "number" || !Number.isFinite(o.value)) {
      throw new ApiError(400, "VALIDATION_ERROR", `observations[${idx}].value 必须是有限数值`, { idx });
    }
    return { aLevel: o.aLevel, bLevel: o.bLevel, value: o.value };
  });
}

function paginate(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "50");
  const pageSize = Math.min(200, Math.max(1, pageSizeRaw || 50));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function pageEnvelope(url: URL, page: number, pageSize: number, result: { items: unknown[]; total: number }) {
  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  return {
    items: result.items,
    page,
    pageSize,
    total: result.total,
    totalPages,
  };
}

export function createApp(store: Store): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const idemKey = req.headers["idempotency-key"];
    const key = Array.isArray(idemKey) ? idemKey[0] : idemKey;
    try {
      const route = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;

      if (route === "GET /health") return send(res, 200, { ok: true });

      if (route === "POST /designs") {
        const body = requireObject(await readJson(req));
        const payload = {
          name: requireString(body, "name"),
          factorA: requireString(body, "factorA"),
          factorB: requireString(body, "factorB"),
          aLevels: requireStringArray(body, "aLevels"),
          bLevels: requireStringArray(body, "bLevels"),
          observations: requireObservations(body),
          supersedes: typeof body.supersedes === "string" ? body.supersedes : undefined,
        };
        const out = store.withIdempotency(key, () => {
          try {
            return store.createDesign(payload);
          } catch (err) {
            throw new ApiError(409, "DESIGN_REJECTED", (err as Error).message);
          }
        });
        return send(res, out.replayed ? 200 : 201, out.data);
      }

      if (route === "GET /designs") {
        const { page, pageSize, limit, offset } = paginate(url);
        return send(res, 200, pageEnvelope(url, page, pageSize, store.listDesigns(limit, offset)));
      }

      const designMatch = url.pathname.match(/^\/designs\/([^/]+)$/);
      if (req.method === "GET" && designMatch) {
        const d = store.getDesign(designMatch![1]);
        if (!d) throw new ApiError(404, "DESIGN_NOT_FOUND", "设计不存在");
        return send(res, 200, d);
      }

      const balanceMatch = url.pathname.match(/^\/designs\/([^/]+)\/balance$/);
      if (req.method === "GET" && balanceMatch) {
        const d = store.getDesign(balanceMatch![1]);
        if (!d) throw new ApiError(404, "DESIGN_NOT_FOUND", "设计不存在");
        const { groupBalanced } = await import("./stats/anova.ts");
        try {
          const { replication } = groupBalanced({
            aLevels: d.aLevels, bLevels: d.bLevels,
            observations: d.observations,
          });
          return send(res, 200, { balanced: true, replication });
        } catch (err: any) {
          return send(res, 422, {
            balanced: false,
            code: err.code ?? "UNBALANCED",
            message: err.message,
            detail: err.detail ?? null,
          });
        }
      }

      if (route === "POST /analyses") {
        const body = requireObject(await readJson(req));
        const designId = requireString(body, "designId");
        const out = store.withIdempotency(key, () => runAnalysis(store, designId));
        return send(res, out.replayed ? 200 : 201, out.data);
      }

      const batchResiduals = url.pathname.match(/^\/batches\/([^/]+)\/residuals$/);
      if (req.method === "GET" && batchResiduals) {
        const b = store.getBatch(batchResiduals![1]);
        if (!b) throw new ApiError(404, "BATCH_NOT_FOUND", "批次不存在");
        if (b.status !== "analyzed") {
          throw new ApiError(409, "BATCH_NOT_ANALYZED", "批次未成功分析");
        }
        return send(res, 200, { residuals: b.analysis.result.residuals });
      }

      if (route === "GET /batches") {
        const { page, pageSize, limit, offset } = paginate(url);
        const designId = url.searchParams.get("designId") ?? undefined;
        return send(res, 200, pageEnvelope(url, page, pageSize, store.listBatches(designId, limit, offset)));
      }

      const batchMatch = url.pathname.match(/^\/batches\/([^/]+)$/);
      if (req.method === "GET" && batchMatch) {
        const b = store.getBatch(batchMatch![1]);
        if (!b) throw new ApiError(404, "BATCH_NOT_FOUND", "批次不存在");
        return send(res, 200, b);
      }

      if (route === "POST /reports/freeze") {
        const body = requireObject(await readJson(req));
        const batchId = requireString(body, "batchId");
        const out = store.withIdempotency(key, () => freezeReport(store, batchId));
        return send(res, out.replayed ? 200 : 201, out.data);
      }

      if (route === "GET /reports") {
        const { page, pageSize, limit, offset } = paginate(url);
        return send(res, 200, pageEnvelope(url, page, pageSize, store.listReports(limit, offset)));
      }

      const reportMatch = url.pathname.match(/^\/reports\/([^/]+)$/);
      if (req.method === "GET" && reportMatch) {
        const r = store.getReport(reportMatch![1]);
        if (!r) throw new ApiError(404, "REPORT_NOT_FOUND", "报告不存在");
        return send(res, 200, r);
      }

      if (route === "POST /synth") {
        const body = requireObject(await readJson(req));
        const scenario = requireString(body, "scenario") as SynthScenario;
        const allowed = ["main-only", "interaction", "constant", "unequal-replication", "missing-cell", "extreme-scale"];
        if (!allowed.includes(scenario)) {
          throw new ApiError(400, "VALIDATION_ERROR", `scenario 必须是 ${allowed.join(", ")}`);
        }
        const seed = typeof body.seed === "number" ? body.seed : 42;
        const design = generate(scenario, seed, body.overrides);
        const d = store.createDesign(design);
        return send(res, 201, d);
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${route}` } });
    } catch (err) {
      if (err instanceof ApiError) {
        return send(res, err.status, { error: { code: err.code, message: err.message, detail: err.detail ?? null } });
      }
      send(res, 500, { error: { code: "INTERNAL", message: (err as Error).message } });
    }
  });
}

/** 仅绑定回环地址；port=0 时由操作系统分配自动端口。 */
export function listenLocal(store: Store, port = 0, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const server = createApp(store);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}
