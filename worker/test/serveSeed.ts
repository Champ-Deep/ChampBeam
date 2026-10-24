/**
 * Direct D1/R2 seeding for the public serve-path tests (serve*.test.ts,
 * pageStateRoutes.test.ts), so they don't depend on the upload/publish/owner
 * routers. Rows mirror what those routers write.
 */
import { afterEach, vi } from "vitest";
import { api, createUser, env } from "./helpers";
import { getSettings, type Env, type Settings } from "../src/env";
import { hashAccessCode } from "../src/lib/accessControl";

export const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
export const code = (prefix = "c") => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

// ---- settings patching (restored after each test) --------------------------
const patched: [Settings, Partial<Settings>][] = [];
export function setSettings(patch: Partial<Settings>) {
  const s = getSettings(env as unknown as Env);
  const saved: Partial<Settings> = {};
  for (const k of Object.keys(patch) as (keyof Settings)[]) (saved as any)[k] = s[k];
  patched.push([s, saved]);
  Object.assign(s, patch);
}
export const settings = () => getSettings(env as unknown as Env);

afterEach(() => {
  while (patched.length) {
    const [s, saved] = patched.pop()!;
    Object.assign(s, saved);
  }
  vi.restoreAllMocks();
});

// ---- rows ----------------------------------------------------------------
export async function seedLink(userId: string, shortCode: string, kw: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const row: Record<string, unknown> = {
    id,
    user_id: userId,
    short_code: shortCode,
    domain_id: null,
    original_url: "https://example.com/dest",
    tracked_url: "https://example.com/dest",
    click_count: 0,
    unique_clicks: 0,
    created_at: iso(),
    ...kw,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO link_clicks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => normalize(row[c])))
    .run();
  return id;
}

export interface SeedFile {
  id: string;
  shortCode: string;
  slug: string | null;
  storageKey: string;
}

/** An active file asset; `body` (when given) is stored in R2 under its key. */
export async function seedFile(
  userId: string,
  opts: {
    shortCode?: string;
    slug?: string | null;
    kind?: string;
    mime?: string;
    filename?: string;
    body?: string | Uint8Array;
    accessCode?: string;
    [col: string]: unknown;
  } = {},
): Promise<SeedFile> {
  const { shortCode = code("f"), slug = null, kind = "pdf", mime = "application/pdf", filename = "deck.pdf", body, accessCode, ...kw } = opts;
  const id = crypto.randomUUID();
  const storageKey = `files/${userId}/${id}/${filename}`;
  const size = body === undefined ? 10 : typeof body === "string" ? new TextEncoder().encode(body).length : body.length;
  const row: Record<string, unknown> = {
    id,
    user_id: userId,
    short_code: shortCode,
    slug,
    filename,
    kind,
    mime_type: mime,
    size_bytes: size,
    storage_key: storageKey,
    status: "active",
    serve_mode: "stream",
    view_count: 0,
    created_at: iso(),
    ...kw,
  };
  if (accessCode) row.access_code_hash = await hashAccessCode(settings(), id, accessCode);
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO file_assets (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => normalize(row[c])))
    .run();
  if (body !== undefined) await env.FILES.put(storageKey, body);
  return { id, shortCode, slug, storageKey };
}

/** A published Beam Page (html asset with a slug + v1 version row). */
export async function seedPage(userId: string, html: string, opts: Record<string, unknown> = {}) {
  const slug = (opts.slug as string | undefined) ?? `page-${crypto.randomUUID().slice(0, 8)}`;
  const f = await seedFile(userId, { kind: "html", mime: "text/html", filename: "index.html", body: html, ...opts, slug });
  await env.DB.prepare(
    "INSERT INTO file_versions (id, file_id, version_no, storage_key, size_bytes, filename, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), f.id, 1, f.storageKey, new TextEncoder().encode(html).length, "index.html", iso())
    .run();
  return f;
}

export async function seedDomain(userId: string, hostname: string, status = "active") {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO domains (id, user_id, hostname, status, is_primary, created_at, provision_attempts, auto_renew) VALUES (?,?,?,?,0,?,0,0)",
  )
    .bind(id, userId, hostname, status, iso())
    .run();
  return id;
}

export const newUser = async () => (await createUser()).id;

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export const row = <T = Record<string, any>>(sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql).bind(...binds).first<T>();
export const rows = async <T = Record<string, any>>(sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).all<T>()).results;

// ---- a minimal cookie jar --------------------------------------------------
export class Jar {
  cookies = new Map<string, string>();
  absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async fetch(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size && !headers.has("cookie")) headers.set("cookie", this.header());
    return this.absorb(await api(path, { ...init, headers }));
  }
}

export const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/** Poll until `fn` returns truthy (background waitUntil work). */
export async function eventually<T>(fn: () => Promise<T>, tries = 50): Promise<T> {
  let last: T = undefined as T;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
}
