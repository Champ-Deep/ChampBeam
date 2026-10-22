/**
 * Beam Pages helpers: slugs, upload guardrails, serve-time injection, versions.
 * Port of backend/app/services/pages_service.py.
 *
 * Pure functions plus a few db-taking helpers, kept out of the routers so the
 * public serve path (routes/filesServe.ts) and the owner API (routes/pages.ts)
 * share exactly one implementation of each rule.
 *
 * Exports:
 *   Slugs
 *     SLUG_RE, RESERVED_SLUGS
 *     validateSlug(raw): string                                  (400 HTTPError)
 *     slugify(title): string
 *     slugTaken(db, slug, domainId, { excludeId? }): Promise<boolean>
 *     uniqueSlug(db, title, domainId): Promise<string>           (503 HTTPError)
 *   Upload guardrails
 *     BLOCKED_EXTENSIONS
 *     validateHtmlUpload(settings, filename, contentType, payload: Uint8Array): void  (400/413)
 *   Visitor identity + injection
 *     VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE
 *     newVisitorId(): string; validVisitorId(v): string | null
 *     injectSnippet(payload: Uint8Array|string, snippet): same type as payload
 *     jsonForScript(value): string        (Python json.dumps compact + "</" escape)
 *     pyJsonDumps(value): string          (Python json.dumps(..., separators=(",", ":")))
 *     trackingSnippet({ visitorId, pageId, beaconUrl, extraJs? }): string
 *     stateSnippetJs(asset): string
 *   Versions
 *     listVersions(db, asset): Promise<FileVersion[]>            (newest first)
 *     nextVersionNo(db, asset): Promise<number>
 *     versionInsert(db, fileId, versionNo, fields)               (unexecuted insert, for db.batch)
 *     recordVersion(db, asset, fields): Promise<FileVersion>
 *     pruneVersions(db, asset, keep): Promise<string[]>          (blob keys safe to delete)
 *     ensureSlug(db, asset, title): Promise<boolean>             (persists; mutates asset.slug)
 *     snapshotIfUnversioned(db, asset): Promise<FileVersion | null>
 *     currentVersionNo(db, asset): Promise<number>
 *     replaceContent(db, asset, next, { keep, snapshot? })       (atomic swap: asset row + new version
 *                                                                 in one db.batch, then prune)
 *   types FileAsset, FileVersion, VersionFields
 */
import { and, desc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import type { Settings } from "../env";
import { chunk, type Db } from "../db/client";
import { FILE_STATUS_DELETED, fileAssets, fileVersions } from "../db/schema";
import { randomString, tokenUrlsafe } from "../lib/crypto";
import { httpError } from "../lib/errors";
import { nowIso } from "../lib/time";
import type { FileAsset } from "./assetLookup";

export type { FileAsset };
export type FileVersion = typeof fileVersions.$inferSelect;

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** 3–60 chars, lowercase alphanumerics and hyphens, no leading/trailing hyphen. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

/**
 * Path prefixes the app itself owns on the serving hosts, plus words that
 * would be confusing as a public page address.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api", "f", "p", "r", "s", "rooms", "health", "docs", "redoc", "openapi.json",
  "static", "assets", "admin", "login", "logout", "sign-in", "sign-up",
  "unlock", "unlock-code", "page-events", "_beam", "beam", "www", "null",
  "undefined",
]);

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Normalize and validate a user-supplied slug; 400 on any rule violation. */
export function validateSlug(raw: string | null | undefined): string {
  const slug = (raw ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    httpError(
      400,
      "Slug must be 3–60 characters of lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.",
    );
  }
  if (RESERVED_SLUGS.has(slug)) httpError(400, `'${slug}' is reserved.`);
  return slug;
}

/** Derive a slug candidate from a title (never throws; may need a suffix). */
export function slugify(title: string | null | undefined): string {
  let base = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (base.length < 3) base = base ? `${base}-page`.replace(/^-+|-+$/g, "") : "page";
  if (RESERVED_SLUGS.has(base)) base = `${base}-page`;
  return base;
}

function rand(n = 6): string {
  return randomString(n, SLUG_ALPHABET);
}

/**
 * Is `slug` already used in this domain namespace (null = platform)?
 * The partial unique indexes are the source of truth; this pre-check gives a
 * clean 409 instead of a 500.
 */
export async function slugTaken(
  db: Db,
  slug: string,
  domainId: string | null,
  opts: { excludeId?: string | null } = {},
): Promise<boolean> {
  const conds = [
    eq(fileAssets.slug, slug),
    ne(fileAssets.status, FILE_STATUS_DELETED),
    domainId === null ? isNull(fileAssets.domainId) : eq(fileAssets.domainId, domainId),
  ];
  if (opts.excludeId != null) conds.push(ne(fileAssets.id, opts.excludeId));
  const rows = await db
    .select({ id: fileAssets.id })
    .from(fileAssets)
    .where(and(...conds))
    .limit(1);
  return rows.length > 0;
}

/** Title-derived slug, unique in its namespace (random suffix on collision). */
export async function uniqueSlug(db: Db, title: string, domainId: string | null): Promise<string> {
  const base = slugify(title);
  const candidates = [base, ...Array.from({ length: 8 }, () => `${base.slice(0, 52)}-${rand()}`)];
  for (const candidate of candidates) {
    if (!(await slugTaken(db, candidate, domainId))) return candidate;
  }
  return httpError(503, "Could not allocate a unique slug.");
}

// ---------------------------------------------------------------------------
// Upload guardrails (PRD P0-7)
// ---------------------------------------------------------------------------

export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "php", "phtml", "asp", "aspx", "jsp", "jspx", "cgi", "pl", "py", "rb",
]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
// Server-side templating markers. `<%` can false-positive on legitimate
// client-side templates; the error message says so.
const SERVER_CODE_MARKERS = ["<?php", "<%"];

const ASCII_WS = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/** Latin-1 view of bytes (1 char per byte) so byte offsets == string offsets. */
function bytesToLatin1(b: Uint8Array, limit = b.length): string {
  const end = Math.min(limit, b.length);
  let out = "";
  for (let i = 0; i < end; i += 8192) {
    out += String.fromCharCode.apply(null, Array.from(b.subarray(i, Math.min(i + 8192, end))));
  }
  return out;
}

/** Reject anything that is not a plain HTML document; never modify bytes. */
export function validateHtmlUpload(
  settings: Pick<Settings, "pagesMaxBytes">,
  filename: string | null | undefined,
  contentType: string | null | undefined,
  payload: Uint8Array,
): void {
  const name = (filename ?? "").trim().toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (BLOCKED_EXTENSIONS.has(ext)) {
    httpError(400, `.${ext} files can't be hosted: Beam Pages serves static HTML only, no server-side code.`);
  }
  const ctype = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (ctype && ctype !== "text/html") httpError(400, `Content type must be text/html (got ${ctype}).`);
  if (!ctype && ext && !HTML_EXTENSIONS.has(ext)) httpError(400, "Only .html files can be published.");
  if (payload.every((b) => ASCII_WS.has(b))) httpError(400, "The page is empty.");
  if (payload.length > settings.pagesMaxBytes) {
    httpError(
      413,
      `Page exceeds the ${Math.floor(settings.pagesMaxBytes / (1024 * 1024))} MB limit. Pages must be a single HTML file.`,
    );
  }
  // bytes.lower() only folds ASCII; so does toLowerCase on the latin-1 view for these markers.
  const lowered = bytesToLatin1(payload, 2 * 1024 * 1024).replace(/[A-Z]+/g, (m) => m.toLowerCase());
  for (const marker of SERVER_CODE_MARKERS) {
    if (lowered.includes(marker)) {
      httpError(
        400,
        `This looks like server-side code (found '${marker}'). Beam Pages serves static HTML only; ` +
          "if this is a client-side template, rename the delimiter.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Visitor identity + serve-time injection (PRD P0-3 / P0-4)
// ---------------------------------------------------------------------------

export const VISITOR_COOKIE = "cb_vid";
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function newVisitorId(): string {
  return tokenUrlsafe(16).slice(0, 22);
}

export function validVisitorId(value: string | null | undefined): string | null {
  if (value && value.length >= 8 && value.length <= 32 && /^[A-Za-z0-9_-]+$/.test(value)) return value;
  return null;
}

// Python's bytes-regex `\s` is ASCII whitespace only.
const HEAD_RE = /<head(?:[ \t\n\r\f\v][^>]*)?>/i;
const HTML_RE = /<html(?:[ \t\n\r\f\v][^>]*)?>/i;

/**
 * Splice `snippet` right after `<head…>` (else `<html…>`, else at the very
 * start). The stored blob is never touched; this is per-response only.
 */
export function injectSnippet(payload: Uint8Array, snippet: string): Uint8Array;
export function injectSnippet(payload: string, snippet: string): string;
export function injectSnippet(payload: Uint8Array | string, snippet: string): Uint8Array | string {
  if (typeof payload === "string") {
    const m = HEAD_RE.exec(payload) ?? HTML_RE.exec(payload);
    if (!m) return snippet + payload;
    const end = m.index + m[0].length;
    return payload.slice(0, end) + snippet + payload.slice(end);
  }
  const blob = new TextEncoder().encode(snippet);
  const view = bytesToLatin1(payload);
  const m = HEAD_RE.exec(view) ?? HTML_RE.exec(view);
  const at = m ? m.index + m[0].length : 0;
  const out = new Uint8Array(payload.length + blob.length);
  out.set(payload.subarray(0, at), 0);
  out.set(blob, at);
  out.set(payload.subarray(at), at + blob.length);
  return out;
}

/**
 * `json.dumps(value, separators=(",", ":"))`: compact, and ensure_ascii (every
 * char outside printable ASCII becomes \uXXXX, as Python does).
 */
export function pyJsonDumps(value: unknown): string {
  const s = JSON.stringify(value);
  if (s === undefined) throw new TypeError("Value is not JSON serializable");
  return s.replace(/[\u007f-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** JSON safe to inline in a <script>: `</` inside a script would close the tag early. */
export function jsonForScript(value: unknown): string {
  return pyJsonDumps(value).replace(/<\//g, "<\\/");
}

// Dwell heartbeat: accumulates visible time, reports on hide/unload and every
// 15 s via sendBeacon (fetch keepalive fallback). Same-origin, so it satisfies
// the hosted-HTML CSP (connect-src 'self'; inline script allowed).
const TRACKING_JS =
  "(function(){var C=%(cfg)s;" +
  "var S=(self.crypto&&crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now()).slice(0,64);" +
  "var acc=0,last=Date.now(),vis=document.visibilityState!=='hidden';" +
  "function tick(){var n=Date.now();if(vis){acc+=n-last;}last=n;}" +
  "function send(){tick();if(acc<250)return;var d=Math.min(acc,60000);acc=0;" +
  "var body=JSON.stringify({session_id:S,visitor_id:C.v,events:[{page:0,dwell_ms:d}]});" +
  "var blob=new Blob([body],{type:'application/json'});" +
  "if(!(navigator.sendBeacon&&navigator.sendBeacon(C.u,blob))){" +
  "try{fetch(C.u,{method:'POST',body:blob,keepalive:true,credentials:'same-origin',headers:{'Content-Type':'application/json'}}).catch(function(){});}catch(e){}}}" +
  "document.addEventListener('visibilitychange',function(){tick();vis=document.visibilityState!=='hidden';if(!vis)send();});" +
  "addEventListener('pagehide',send);setInterval(send,15000);" +
  "%(extra)s})();";

/** Python `%`-style named substitution without `$` pattern surprises. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/%\((\w+)\)s/g, (_, k: string) => values[k] ?? "");
}

export function trackingSnippet(opts: { visitorId: string; pageId: string; beaconUrl: string; extraJs?: string }): string {
  const cfg = jsonForScript({ v: opts.visitorId, p: opts.pageId, u: opts.beaconUrl });
  return "<script>" + fill(TRACKING_JS, { cfg, extra: opts.extraJs ?? "" }) + "</script>";
}

// Beam State helper exposed to the page as window.beam (see docs/API.md). Runs
// inside the tracking IIFE; promise-based (no async/await) for older engines.
const STATE_JS =
  "window.__BEAM__={page:%(page)s,token:%(token)s,api:'/api/pages'};" +
  "(function(){var B=window.__BEAM__,H={'Content-Type':'application/json','X-Beam-Token':B.token};" +
  "function u(p){return B.api+'/'+encodeURIComponent(B.page)+p}" +
  "function j(m,p,b){return fetch(u(p),{method:m,headers:H,credentials:'same-origin',body:b===undefined?undefined:JSON.stringify(b)})" +
  ".then(function(r){if(r.status===410){window.beam.dead=true;throw new Error('page disabled')}" +
  "if(!r.ok)throw new Error('beam '+r.status);return r.status===204?null:r.json()})}" +
  "window.beam={dead:false," +
  "comments:{list:function(a){return j('GET','/comments'+(a?'?after='+encodeURIComponent(a):''))}," +
  "add:function(author,body){return j('POST','/comments',{author:author,body:body})}}," +
  "state:{get:function(k){return j('GET','/state/'+encodeURIComponent(k)).then(function(x){return x.value})}," +
  "set:function(k,v){return j('PUT','/state/'+encodeURIComponent(k),v)}," +
  "all:function(){return j('GET','/state').then(function(x){return x.state})}}," +
  "poll:function(ms,cb){ms=Math.max(ms||8000,3000);var t=setInterval(function(){" +
  "Promise.all([window.beam.state.all(),window.beam.comments.list()]).then(function(r){cb(r[0],r[1].comments)}).catch(function(){})},ms);" +
  "return function(){clearInterval(t)}}};})();";

/**
 * Extra JS appended inside the tracking IIFE: the Beam State helper. Empty
 * when the page has no token yet (never for served pages: the serve path mints
 * one before rendering).
 */
export function stateSnippetJs(asset: Pick<FileAsset, "stateToken" | "slug" | "shortCode">): string {
  const token = asset.stateToken;
  if (!token) return "";
  const ident = asset.slug || asset.shortCode;
  return fill(STATE_JS, { page: jsonForScript(ident), token: jsonForScript(token) });
}

// ---------------------------------------------------------------------------
// Versions (PRD P0-5 / P1 rollback)
// ---------------------------------------------------------------------------

export interface VersionFields {
  storageKey: string;
  sizeBytes: number;
  sha256: string | null;
  filename: string;
}

export async function listVersions(db: Db, asset: Pick<FileAsset, "id">): Promise<FileVersion[]> {
  return db.select().from(fileVersions).where(eq(fileVersions.fileId, asset.id)).orderBy(desc(fileVersions.versionNo));
}

export async function nextVersionNo(db: Db, asset: Pick<FileAsset, "id">): Promise<number> {
  const rows = await db
    .select({ current: max(fileVersions.versionNo) })
    .from(fileVersions)
    .where(eq(fileVersions.fileId, asset.id));
  return Number(rows[0]?.current ?? 0) + 1;
}

/** Unexecuted insert of one version row, for use inside `db.batch([...])`. */
export function versionInsert(db: Db, fileId: string, versionNo: number, fields: VersionFields) {
  return db
    .insert(fileVersions)
    .values({
      id: crypto.randomUUID(),
      fileId,
      versionNo,
      storageKey: fields.storageKey,
      sizeBytes: fields.sizeBytes,
      sha256: fields.sha256,
      filename: fields.filename,
      createdAt: nowIso(),
    })
    .returning();
}

export async function recordVersion(db: Db, asset: Pick<FileAsset, "id">, fields: VersionFields): Promise<FileVersion> {
  const rows = await versionInsert(db, asset.id, await nextVersionNo(db, asset), fields);
  return rows[0];
}

/**
 * Drop version rows beyond `keep` newest; return blob keys safe to delete
 * (never the asset's live key, never a key still referenced by a kept row).
 * Pass `settings.pagesVersionsKeep` for the Python default. `asset.storageKey`
 * must be the live key AFTER any swap.
 */
export async function pruneVersions(
  db: Db,
  asset: Pick<FileAsset, "id" | "storageKey">,
  keep: number,
): Promise<string[]> {
  const versions = await listVersions(db, asset);
  const keptKeys = new Set([...versions.slice(0, keep).map((v) => v.storageKey), asset.storageKey]);
  const doomed = versions.slice(keep);
  const keys = doomed.filter((v) => !keptKeys.has(v.storageKey)).map((v) => v.storageKey);
  for (const ids of chunk(doomed.map((v) => v.id))) {
    await db.delete(fileVersions).where(inArray(fileVersions.id, ids));
  }
  return keys;
}

/**
 * Give a pre-Beam-Pages HTML upload a slug on first sight so it gets a
 * readable /p/ URL. Returns true when the row changed. Unlike Python (caller
 * commits), the new slug is persisted here and set on `asset`.
 */
export async function ensureSlug(db: Db, asset: FileAsset, title: string): Promise<boolean> {
  if (asset.slug) return false;
  const slug = await uniqueSlug(db, title, asset.domainId ?? null);
  await db.update(fileAssets).set({ slug }).where(eq(fileAssets.id, asset.id));
  asset.slug = slug;
  return true;
}

/**
 * Uploads that predate version history have no v1. Before the first replace,
 * record the bytes currently being served so they stay rollback-able.
 */
export async function snapshotIfUnversioned(db: Db, asset: FileAsset): Promise<FileVersion | null> {
  if ((await nextVersionNo(db, asset)) !== 1) return null;
  return recordVersion(db, asset, {
    storageKey: asset.storageKey,
    sizeBytes: asset.sizeBytes ?? 0,
    sha256: asset.sha256,
    filename: asset.filename,
  });
}

export async function currentVersionNo(db: Db, asset: Pick<FileAsset, "id" | "storageKey">): Promise<number> {
  const rows = await db
    .select({ versionNo: fileVersions.versionNo })
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, asset.id), eq(fileVersions.storageKey, asset.storageKey)))
    .orderBy(desc(fileVersions.versionNo))
    .limit(1);
  return Number(rows[0]?.versionNo ?? 0);
}

/**
 * The content-swap sequence shared by update_page and rollback_version:
 * (optional snapshot of an unversioned asset as v1) + point the asset row at
 * the new blob + record the new version, all in ONE db.batch (the single
 * Python commit), then prune beyond `keep`. Mutates and returns `asset`.
 * Pass `snapshot: true` for update_page (snapshot_if_unversioned), omit for
 * rollback. Delete the returned `doomed` keys from R2 afterwards (best effort).
 */
export async function replaceContent(
  db: Db,
  asset: FileAsset,
  next: VersionFields,
  opts: { keep: number; snapshot?: boolean },
): Promise<{ asset: FileAsset; version: FileVersion; doomed: string[] }> {
  let versionNo = await nextVersionNo(db, asset);
  const snapshot =
    opts.snapshot && versionNo === 1
      ? versionInsert(db, asset.id, versionNo++, {
          storageKey: asset.storageKey,
          sizeBytes: asset.sizeBytes ?? 0,
          sha256: asset.sha256,
          filename: asset.filename,
        })
      : null;
  const update = db
    .update(fileAssets)
    .set({ storageKey: next.storageKey, filename: next.filename, sizeBytes: next.sizeBytes, sha256: next.sha256 })
    .where(eq(fileAssets.id, asset.id));
  const insert = versionInsert(db, asset.id, versionNo, next);
  const results = snapshot ? await db.batch([snapshot, update, insert]) : await db.batch([update, insert]);
  const version = (results[results.length - 1] as FileVersion[])[0];
  asset.storageKey = next.storageKey;
  asset.filename = next.filename;
  asset.sizeBytes = next.sizeBytes;
  asset.sha256 = next.sha256;
  const doomed = await pruneVersions(db, asset, opts.keep);
  return { asset, version, doomed };
}
