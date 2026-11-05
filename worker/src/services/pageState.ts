/**
 * Beam State service: page resolution, public token, write limits, events.
 * Port of backend/app/services/page_state.py.
 *
 * Shared by the public /api/pages/{ident}/… router and the owner-facing
 * /api/v1/pages/{id}/… endpoints so every rule has exactly one implementation.
 *
 * Exports:
 *   MAX_COMMENTS_PER_PAGE, MAX_KEYS_PER_PAGE, MAX_COMMENT_BODY, MAX_AUTHOR,
 *   MAX_VALUE_BYTES, WRITES_PER_MINUTE, KEY_RE, TOKEN_HEADER
 *   resolvePublicPage(c, ident): Promise<FileAsset | null>
 *   resolvePublicPageForHost(db, settings, host, ident): Promise<FileAsset | null>
 *   pageKilled(asset, now?): boolean
 *   ensureStateToken(db, asset): Promise<string>   (persists when minted; mutates asset)
 *   rotateStateToken(db, asset): Promise<string>   (persists; mutates asset)
 *   checkToken(asset, headers: Headers): void      (401 HTTPError)
 *   enforceWriteLimit(d1: D1Database, ip, pageId): Promise<void>   (429 HTTPError)
 *   validateKey(key): string                       (400)
 *   validateValue(value): string                   (400/413; returns compact JSON)
 *   validateComment(author, body): [author, body]  (400/413)
 *   commentCount(db, pageId), keyCount(db, pageId): Promise<number>
 *   pageEventInsert(db, pageId, eventType, opts)   (unexecuted insert, for db.batch)
 *   recordPageEvent(db, pageId, eventType, opts): Promise<PageEvent>
 *   types PageComment, PageStateRow, PageEvent
 */
import { and, count, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv, Settings } from "../env";
import type { Db } from "../db/client";
import { FILE_KIND_HTML, fileAssets, pageComments, pageEvents, pageState } from "../db/schema";
import { timingSafeEqual, tokenUrlsafe } from "../lib/crypto";
import { httpError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { nowIso, parseIso } from "../lib/time";
import { type FileAsset, lookupAsset, requestHost, resolveHost } from "./assetLookup";
import { pyJsonDumps } from "./pages";

export type PageComment = typeof pageComments.$inferSelect;
export type PageStateRow = typeof pageState.$inferSelect;
export type PageEvent = typeof pageEvents.$inferSelect;

// Hard caps enforced in SQL/validation (the rate windows fail open, these don't).
export const MAX_COMMENTS_PER_PAGE = 5000;
export const MAX_KEYS_PER_PAGE = 200;
export const MAX_COMMENT_BODY = 4000;
export const MAX_AUTHOR = 120;
export const MAX_VALUE_BYTES = 16 * 1024;
export const WRITES_PER_MINUTE = 30;

export const KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
export const TOKEN_HEADER = "X-Beam-Token";

// ---------------------------------------------------------------------------
// Page resolution + lifecycle
// ---------------------------------------------------------------------------

/**
 * Host-aware lookup by slug (preferred) or short code; html pages only.
 * Returns null for unknown pages AND for unregistered custom hosts.
 */
export async function resolvePublicPageForHost(
  db: Db,
  settings: Settings,
  host: string,
  ident: string,
): Promise<FileAsset | null> {
  const { domain, unknownHost } = await resolveHost({ db, settings, host });
  if (unknownHost) return null;
  const raw = (ident ?? "").trim();
  // Slugs are lowercase by construction; short codes are case-sensitive.
  const asset =
    (await lookupAsset(db, domain, { slug: raw.toLowerCase() })) ?? (await lookupAsset(db, domain, { shortCode: raw }));
  if (!asset || asset.kind !== FILE_KIND_HTML) return null;
  return asset;
}

export async function resolvePublicPage(c: Context<AppEnv>, ident: string): Promise<FileAsset | null> {
  return resolvePublicPageForHost(c.var.db, c.var.settings, requestHost(c), ident);
}

/** True when the page itself would be blocked (kill switch semantics). */
export function pageKilled(
  asset: Pick<FileAsset, "revokedAt" | "expiresAt" | "maxViews" | "viewCount">,
  now: Date = new Date(),
): boolean {
  if (asset.revokedAt != null) return true;
  const exp = parseIso(asset.expiresAt);
  if (exp && exp.getTime() < now.getTime()) return true;
  if (asset.maxViews != null && (asset.viewCount ?? 0) >= asset.maxViews) return true;
  return false;
}

/**
 * Lazily mint the page's public state token. Python left the commit to the
 * caller; here it is persisted immediately, race-safe (only written while
 * still NULL, otherwise the concurrent winner's token is adopted).
 */
export async function ensureStateToken(db: Db, asset: FileAsset): Promise<string> {
  if (asset.stateToken) return asset.stateToken;
  const token = tokenUrlsafe(24);
  const won = await db
    .update(fileAssets)
    .set({ stateToken: token })
    .where(and(eq(fileAssets.id, asset.id), isNull(fileAssets.stateToken)))
    .returning({ stateToken: fileAssets.stateToken });
  if (won.length) {
    asset.stateToken = token;
  } else {
    const row = await db.select({ stateToken: fileAssets.stateToken }).from(fileAssets).where(eq(fileAssets.id, asset.id));
    asset.stateToken = row[0]?.stateToken ?? token;
  }
  return asset.stateToken!;
}

/** Mint a new token (persisted); the old one is rejected immediately. */
export async function rotateStateToken(db: Db, asset: FileAsset): Promise<string> {
  const token = tokenUrlsafe(24);
  await db.update(fileAssets).set({ stateToken: token }).where(eq(fileAssets.id, asset.id));
  asset.stateToken = token;
  return token;
}

/** 401 unless the request carries this page's token (X-Beam-Token or Bearer). */
export function checkToken(asset: Pick<FileAsset, "stateToken">, headers: Headers): void {
  let presented = (headers.get(TOKEN_HEADER) ?? "").trim();
  if (!presented) {
    const auth = headers.get("Authorization") ?? "";
    if (auth.toLowerCase().startsWith("bearer ")) presented = auth.slice(7).trim();
  }
  const expected = asset.stateToken ?? "";
  if (!presented || !expected || !timingSafeEqual(presented, expected)) {
    httpError(401, "Invalid page token");
  }
}

// ---------------------------------------------------------------------------
// Limits + validation
// ---------------------------------------------------------------------------

/** Fixed window per IP+page; fails open when the counter store is unavailable. */
export async function enforceWriteLimit(d1: D1Database, ip: string | null | undefined, pageId: string): Promise<void> {
  await enforceLimit(
    d1,
    `pgst_rl:${pageId}:${ip || "-"}`,
    WRITES_PER_MINUTE,
    60,
    `Too many writes (${WRITES_PER_MINUTE}/minute per page).`,
  );
}

export function validateKey(key: string | null | undefined): string {
  if (!KEY_RE.test(key ?? "")) {
    httpError(400, "Key must be 1–120 characters of letters, digits, '_', '.', ':' or '-'.");
  }
  return key!;
}

/** Compact JSON of `value`; 400 when not serializable, 413 over MAX_VALUE_BYTES (UTF-8, Python encoding). */
export function validateValue(value: unknown): string {
  let encoded: string;
  try {
    encoded = pyJsonDumps(value);
  } catch {
    return httpError(400, "Value must be JSON-serializable.");
  }
  // pyJsonDumps output is pure ASCII (ensure_ascii), so length == UTF-8 bytes.
  if (encoded.length > MAX_VALUE_BYTES) httpError(413, `Value exceeds ${Math.floor(MAX_VALUE_BYTES / 1024)} KB.`);
  return encoded;
}

/** Length in code points (Python len()). */
const pyLen = (s: string) => [...s].length;

export function validateComment(author: string | null | undefined, body: string | null | undefined): [string, string] {
  const a = (author ?? "").trim();
  const b = (body ?? "").trim();
  if (!a || pyLen(a) > MAX_AUTHOR) httpError(400, `Author is required (max ${MAX_AUTHOR} chars).`);
  if (!b) httpError(400, "Comment body is required.");
  if (pyLen(b) > MAX_COMMENT_BODY) httpError(413, `Comment exceeds ${MAX_COMMENT_BODY} characters.`);
  return [a, b];
}

export async function commentCount(db: Db, pageId: string): Promise<number> {
  const rows = await db.select({ n: count() }).from(pageComments).where(eq(pageComments.pageId, pageId));
  return Number(rows[0]?.n ?? 0);
}

export async function keyCount(db: Db, pageId: string): Promise<number> {
  const rows = await db.select({ n: count() }).from(pageState).where(eq(pageState.pageId, pageId));
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface PageEventOpts {
  ref?: string | null;
  visitorId?: string | null;
  ip?: string | null;
}

const clip = (v: unknown, n: number): string | null => (v ? String(v).slice(0, n) : null);

/**
 * Unexecuted insert of a typed page event, for `db.batch([...])` together with
 * the write it describes (Python added it to the session; the caller committed).
 */
export function pageEventInsert(db: Db, pageId: string, eventType: string, opts: PageEventOpts = {}) {
  return db
    .insert(pageEvents)
    .values({
      id: crypto.randomUUID(),
      pageId,
      eventType,
      ref: clip(opts.ref, 160),
      visitorId: clip(opts.visitorId, 64),
      ip: clip(opts.ip, 45),
      createdAt: nowIso(),
    })
    .returning();
}

/** Single seam for typed page events; executes the insert immediately. */
export async function recordPageEvent(
  db: Db,
  pageId: string,
  eventType: string,
  opts: PageEventOpts = {},
): Promise<PageEvent> {
  const rows = await pageEventInsert(db, pageId, eventType, opts);
  return rows[0];
}
