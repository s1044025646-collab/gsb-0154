import { AppError } from "../types.ts";

export function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError("BAD_JSON", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError("VALIDATION", `'${key}' must be a non-empty string`);
  }
  return v;
}

export function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new AppError("VALIDATION", `'${key}' must be a string`);
  return v;
}

export function intParam(url: URL, key: string, dflt?: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    if (dflt !== undefined) return dflt;
    throw new AppError("VALIDATION", `query parameter '${key}' is required`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new AppError("VALIDATION", `query parameter '${key}' must be an integer`);
  return n;
}

export function optInt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new AppError("VALIDATION", `'${key}' must be an integer`);
  }
  return v;
}

export function factorSpec(obj: Record<string, unknown>, key: string): { name: string; levels: string[] } {
  const v = obj[key];
  if (typeof v !== "object" || v === null) {
    throw new AppError("VALIDATION", `'${key}' must be an object { name, levels }`);
  }
  const f = v as Record<string, unknown>;
  const name = str(f, "name");
  const levels = f.levels;
  if (!Array.isArray(levels) || levels.some((l) => typeof l !== "string")) {
    throw new AppError("VALIDATION", `'${key}.levels' must be an array of strings`);
  }
  return { name, levels: levels as string[] };
}

export function observationsSpec(obj: Record<string, unknown>) {
  const arr = obj.observations;
  if (!Array.isArray(arr)) throw new AppError("VALIDATION", "'observations' must be an array");
  return arr.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new AppError("VALIDATION", "each observation must be an object");
    }
    const o = raw as Record<string, unknown>;
    return {
      level_a: str(o, "level_a"),
      level_b: str(o, "level_b"),
      replicate: Number(o.replicate),
      value: Number(o.value),
      client_ref: optStr(o, "client_ref"),
    };
  });
}
