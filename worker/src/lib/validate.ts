/**
 * Request parsing with FastAPI-shaped 422s. Replaces Pydantic request models:
 * declare a zod schema mirroring the Pydantic model, then
 *
 *   const body = await parseJson(c, CreateThing);           // body model
 *   const q = parseQuery(c, z.object({ days: qInt(30) }));  // Query(...) params
 *
 * Unknown body keys are ignored (Pydantic's default `extra="ignore"`).
 */
import type { Context } from "hono";
import { z } from "zod";
import { HTTPError, type ValidationIssue } from "./errors";

function issuesFrom(err: z.ZodError, where: "body" | "query" | "path", input: unknown): ValidationIssue[] {
  return err.issues.map((i) => {
    const missing = i.code === "invalid_type" && getIn(input, i.path) === undefined;
    return {
      type: missing ? "missing" : i.code,
      loc: [where, ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))],
      msg: missing ? "Field required" : i.message,
      input: getIn(input, i.path),
    };
  });
}

function getIn(obj: unknown, path: PropertyKey[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[p];
  }
  return cur;
}

export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    throw new HTTPError(422, [
      { type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {} },
    ]);
  }
  if (raw === undefined) {
    throw new HTTPError(422, [{ type: "missing", loc: ["body"], msg: "Field required", input: null }]);
  }
  const res = schema.safeParse(raw);
  if (!res.success) throw new HTTPError(422, issuesFrom(res.error, "body", raw));
  return res.data;
}

/** Parse the query string. Repeated keys become arrays only if the schema wants one. */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const url = new URL(c.req.url);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    raw[key] = all.length > 1 ? all : all[0];
  }
  const res = schema.safeParse(raw);
  if (!res.success) throw new HTTPError(422, issuesFrom(res.error, "query", raw));
  return res.data;
}

/** Validate a UUID path parameter the way FastAPI's `UUID` type does (422). */
export function uuidParam(c: Context, name: string): string {
  const v = c.req.param(name) ?? "";
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v)) {
    throw new HTTPError(422, [
      { type: "uuid_parsing", loc: ["path", name], msg: "Input should be a valid UUID", input: v },
    ]);
  }
  const hex = v.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- Query-param coercion helpers (query values arrive as strings) --------

/** Optional int query param with default and optional bounds (Query(default, ge, le)). */
export const qInt = (def?: number, opts: { ge?: number; le?: number } = {}) => {
  let s = z.coerce.number().int();
  if (opts.ge !== undefined) s = s.min(opts.ge);
  if (opts.le !== undefined) s = s.max(opts.le);
  return def === undefined ? s.optional() : s.default(def);
};

/** Optional bool query param ("true"/"false"/"1"/"0"). */
export const qBool = (def?: boolean) => {
  const s = z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "boolean" ? v : ["true", "1", "yes", "on"].includes(v.toLowerCase())));
  return def === undefined ? s.optional() : s.default(def);
};

/** Optional string query param. */
export const qStr = (def?: string) => (def === undefined ? z.string().optional() : z.string().default(def));
