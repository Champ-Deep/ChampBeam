/**
 * Public serve endpoint for hosted file assets. Port of backend/app/api/files.py
 * — mounted at / (/f/..., /p/...).
 *
 * Routes `GET /f/{code}` and `GET /f/{code}/{slug}` (the slug is purely
 * cosmetic, the short_code is what we look up) plus Beam Pages' `/p/{slug}`.
 * Mirrors the redirect handler: the Host header decides which short-code
 * namespace to look in (services/assetLookup.ts).
 *
 * Beyond the Python: streamed (non-injected) bodies honour a single HTTP Range
 * (206 / 416) so video seeking works straight from R2.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { chunk } from "../db/client";
import {
  FILE_KIND_HTML,
  FILE_KIND_OTHER,
  PAGE_EVENT_GATE_FAILED,
  SERVE_REDIRECT,
  pageEngagements,
} from "../db/schema";
import {
  captureLead,
  clientIp,
  codeAttemptLimited,
  codeCookieName,
  codeCookieValue,
  gateCookieName,
  hasCodeCookie,
  hasGateCookie,
  isVpnIp,
  validEmail,
  verifyAccessCode,
} from "../lib/accessControl";
import { blockedPage, codeGatePage, emailGatePage } from "../lib/accessPages";
import { background } from "../lib/background";
import { cfGeo, getCookie } from "../lib/request";
import { StorageError, StorageNotConfigured, backendIsS3, generatePresignedGet, getObject } from "../lib/storage";
import { diffSeconds, nowIso, parseIso } from "../lib/time";
import { parseJson } from "../lib/validate";
import { type Domain, type FileAsset, lookupAsset, resolveHost } from "../services/assetLookup";
import { expireAsset } from "../services/fileExpiry";
import { ensureStateToken, recordPageEvent } from "../services/pageState";
import {
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE,
  injectSnippet,
  newVisitorId,
  stateSnippetJs,
  trackingSnippet,
  validVisitorId,
} from "../services/pages";
import { captureVisit, lastFileViewAt, recordFileViewEvent, scheduleGeoEnrichment } from "../services/utm";
import { formField, isHttps, redirectResponse, starletteCookie } from "./_serveCommon";

export const router = new Hono<AppEnv>({ strict: false });

const GATE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

// Tight CSP for HTML files. Prevents the served page from loading external
// script/font/image resources or framing other origins. Inline scripts are
// left allowed (a hosted landing page often needs basic interactivity).
const HTML_CSP =
  "default-src 'self' data:; " +
  "img-src 'self' data: blob:; " +
  // Google Fonts is the one external dependency hosted pages routinely need
  // (stylesheet from fonts.googleapis.com, woff2 from fonts.gstatic.com).
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "script-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "form-action 'self'; " +
  "base-uri 'self'";

function safeFilename(name: string): string {
  return [...name.replace(/"/g, "").replace(/\n/g, " ")].slice(0, 255).join("");
}

function commonHeaders(asset: FileAsset): Record<string, string> {
  // Arbitrary or unknown files (KIND_OTHER: zip, docs, archives) download
  // rather than render inline, which is also the safe default for untrusted
  // bytes served from our own origin.
  const disposition = asset.kind === FILE_KIND_OTHER ? "attachment" : "inline";
  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType,
    "Content-Disposition": `${disposition}; filename="${safeFilename(asset.filename)}"`,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (asset.kind === FILE_KIND_HTML) headers["Content-Security-Policy"] = HTML_CSP;
  return headers;
}

async function readBlob(bucket: R2Bucket, key: string): Promise<Uint8Array> {
  const obj = await getObject(bucket, key);
  return new Uint8Array(await obj.arrayBuffer());
}

/** Starlette `Response(status_code=..., content="...")`: no media type, so no Content-Type. */
const text = (body: string, status: number) => new Response(new TextEncoder().encode(body), { status });

// ---------------------------------------------------------------------------
// Range requests
// ---------------------------------------------------------------------------

type ParsedRange = { offset: number; length: number } | "unsatisfiable" | null;

/**
 * Parse a single-range `Range: bytes=...` header against the object size.
 * null = ignore (no header, malformed, or multi-range -> serve the full body).
 */
function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    const len = Math.min(suffix, size);
    return size === 0 ? "unsatisfiable" : { offset: size - len, length: len };
  }
  const start = Number(m[1]);
  let end = m[2] === "" ? size - 1 : Number(m[2]);
  if (m[2] !== "" && end < start) return null;
  if (start >= size) return "unsatisfiable";
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}

/** True for a Range request that continues an already-counted view (seek / resume). */
function isContinuationRange(header: string | undefined): boolean {
  if (!header) return false;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-/i.exec(header);
  if (!m) return false;
  return m[1] === "" || Number(m[1]) > 0;
}

/** Stream the blob from R2, honouring a single Range. */
async function streamBlob(c: Ctx, asset: FileAsset): Promise<Response> {
  const headers = new Headers(commonHeaders(asset));
  headers.set("Accept-Ranges", "bytes");
  const bucket = c.env.FILES;
  const rangeHeader = c.req.header("range");
  if (rangeHeader) {
    const head = await bucket.head(asset.storageKey);
    if (!head) throw new StorageError(`Object not found: ${asset.storageKey}`);
    const range = parseRange(rangeHeader, head.size);
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const obj = await getObject(bucket, asset.storageKey, { range });
      headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
      headers.set("Content-Length", String(range.length));
      return new Response(obj.body, { status: 206, headers });
    }
  }
  const obj = await getObject(bucket, asset.storageKey);
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

/** Gates -> count the view -> serve. Shared by /f/{code} and /p/{slug}. */
async function serveAsset(c: Ctx, asset: FileAsset, domain: Domain | null): Promise<Response> {
  const { db, settings } = c.var;
  const shortCode = asset.shortCode;
  const brand = asset.branded && domain ? domain.hostname : null;
  const ip = clientIp(c);

  // --- Access gates (before serving / counting a view) -----------------
  // Access-code gate first: authorize before identify, so uninvited visitors
  // are never asked for (and never leak) an email.
  if (asset.accessCodeHash && !(await hasCodeCookie(c, asset))) {
    return codeGatePage({ action: `/f/${shortCode}/unlock-code`, brand });
  }
  // Email gate: capture a lead before access.
  if (asset.requireEmail && !hasGateCookie(c, shortCode)) {
    return emailGatePage({ action: `/f/${shortCode}/unlock`, brand });
  }
  // VPN/proxy block.
  if (asset.blockVpn && (await isVpnIp({ settings, db }, ip, { cf: cfGeo(c) }))) {
    return blockedPage("vpn", { brand });
  }
  // Manual kill.
  if (asset.revokedAt != null) return blockedPage("revoked", { brand });
  // Time expiry (anonymous auto-expiry + authed self-destruct). Reclaim in bg.
  const exp = parseIso(asset.expiresAt);
  if (exp && exp.getTime() < Date.now()) {
    const bucket = c.env.FILES;
    background(c, () => expireAsset(bucket, db, asset.id), "expireAsset");
    return blockedPage("expired", { brand });
  }
  // View cap (burn-after-N). view_count reflects prior views.
  if (asset.maxViews != null && (asset.viewCount ?? 0) >= asset.maxViews) {
    return blockedPage("maxed", { brand });
  }

  // --- Visitor identity + revisit detection ----------------------------
  let visitorId = validVisitorId(getCookie(c, VISITOR_COOKIE));
  const isNewVisitor = visitorId === null;
  if (visitorId === null) visitorId = newVisitorId();

  // A video player's follow-up Range requests (seeks, resumes) belong to the
  // view already counted by its first request; don't count each one.
  const rangeHeader = c.req.header("range");
  const countView = !isContinuationRange(rangeHeader);

  if (countView) {
    let isRevisit = false;
    if (!isNewVisitor) {
      const last = await lastFileViewAt(db, asset.id, visitorId);
      if (last !== null) isRevisit = diffSeconds(last, nowIso()) >= settings.pagesRevisitWindowS;
    }

    // Beam State: hosted pages get a page-scoped public token (minted lazily,
    // persisted) that the injected helper uses.
    if (asset.kind === FILE_KIND_HTML) await ensureStateToken(db, asset);

    const visit = captureVisit(c, ip);
    const event = await recordFileViewEvent(db, asset, {
      ipAddress: ip,
      userAgent: visit.userAgent,
      referrer: visit.referrer,
      domainId: domain ? domain.id : null,
      visitorId,
      isRevisit,
    });
    if (ip) scheduleGeoEnrichment(c, event.id, visit);
  } else if (asset.kind === FILE_KIND_HTML) {
    await ensureStateToken(db, asset);
  }

  // Redirect-serve (large videos) only applies when presigned R2 URLs are
  // available; otherwise the Worker streams from the binding.
  if (asset.serveMode === SERVE_REDIRECT && backendIsS3(settings)) {
    let url: string;
    try {
      url = await generatePresignedGet(settings, asset.storageKey, asset.filename, 300);
    } catch (err) {
      if (err instanceof StorageNotConfigured) return text("Storage not configured.", 503);
      console.error(`presigned_get failed for key=${asset.storageKey}`, err);
      return text("Storage error.", 502);
    }
    return redirectResponse(url, 302);
  }

  let resp: Response;
  try {
    if (asset.kind === FILE_KIND_HTML && (asset.sizeBytes ?? 0) <= settings.pagesInjectMaxBytes) {
      // Beam Pages: inject the tracking snippet at serve time. The stored blob
      // is never modified; the body is per-visitor so it is not cached.
      const payload = await readBlob(c.env.FILES, asset.storageKey);
      const snippet = trackingSnippet({
        visitorId,
        pageId: asset.id,
        beaconUrl: `/f/${shortCode}/page-events`,
        extraJs: stateSnippetJs(asset),
      });
      const body = injectSnippet(payload, snippet);
      const headers = new Headers(commonHeaders(asset));
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Length", String(body.length));
      resp = new Response(body, { status: 200, headers });
    } else {
      // Stream mode: bytes proxied through the Worker from R2.
      resp = await streamBlob(c, asset);
    }
  } catch (err) {
    if (err instanceof StorageNotConfigured) return text("Storage not configured.", 503);
    if (err instanceof StorageError) {
      console.error(`serve: blob read failed for key=${asset.storageKey}`, err);
      return text("Storage error.", 502);
    }
    throw err;
  }

  resp.headers.append(
    "set-cookie",
    starletteCookie(VISITOR_COOKIE, visitorId, {
      maxAge: VISITOR_COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps(c),
      path: "/",
    }),
  );
  return resp;
}

async function serveFile(c: Ctx): Promise<Response> {
  const { domain, unknownHost } = await resolveHost(c);
  // Custom hostname that isn't registered or isn't active: refuse rather than
  // fall through to the platform-default bucket.
  if (unknownHost) return text("File not found.", 404);
  const asset = await lookupAsset(c.var.db, domain, { shortCode: c.req.param("short_code")! });
  if (!asset) return text("File not found.", 404);
  return serveAsset(c, asset, domain);
}

router.get("/f/:short_code", serveFile);
router.get("/f/:short_code/:slug", serveFile); // slug is cosmetic

/**
 * Beam Pages: serve a hosted page by its editable slug (same gates and
 * tracking as /f/{code}; the page's legacy /f/ URL keeps working too).
 */
router.get("/p/:slug", async (c) => {
  const { domain, unknownHost } = await resolveHost(c);
  if (unknownHost) return text("Page not found.", 404);
  const asset = await lookupAsset(c.var.db, domain, { slug: c.req.param("slug").trim().toLowerCase() });
  if (!asset || asset.kind !== FILE_KIND_HTML) return text("Page not found.", 404);
  return serveAsset(c, asset, domain);
});

// ---------------------------------------------------------------------------
// Per-page dwell beacons
// ---------------------------------------------------------------------------

// A single heartbeat can never claim more than this; the snippet reports every
// 15 s, so anything larger is a stalled tab or a forged payload.
const MAX_DWELL_PER_REPORT_MS = 60_000;

const PageEventsRequest = z.object({
  session_id: z.string().min(1).max(64),
  visitor_id: z.string().max(32).nullish(),
  events: z
    .array(
      z.object({
        page: z.number().int().min(0).max(100000),
        dwell_ms: z.number().int().min(0).max(86_400_000), // cap a single page at 24h
      }),
    )
    .max(1000),
});

/**
 * Public: the instrumented viewer reports per-page dwell time for a document.
 * No auth — viewers aren't signed in; the file is identified by its short code
 * (+ host namespace), same as the serve path.
 */
router.post("/f/:short_code/page-events", async (c) => {
  const data = await parseJson(c, PageEventsRequest);
  const { domain, unknownHost } = await resolveHost(c);
  if (unknownHost) return text("File not found.", 404);
  const db = c.var.db;
  const asset = await lookupAsset(db, domain, { shortCode: c.req.param("short_code") });
  if (!asset) return text("File not found.", 404);

  const ip = clientIp(c);
  const sid = data.session_id.slice(0, 64);
  // Trust the cookie over the body; fall back to the body for beacons sent
  // without credentials.
  const visitorId = validVisitorId(getCookie(c, VISITOR_COOKIE)) ?? validVisitorId(data.visitor_id);
  const now = nowIso();
  const rows = data.events.map((e) => ({
    id: crypto.randomUUID(),
    fileId: asset.id,
    sessionId: sid,
    visitorId,
    page: e.page,
    dwellMs: Math.min(e.dwell_ms, MAX_DWELL_PER_REPORT_MS),
    ipAddress: ip,
    createdAt: now,
  }));
  // 8 bound params per row; stay under D1's 100-parameter cap per statement.
  const inserts = chunk(rows, 12).map((part) => db.insert(pageEngagements).values(part));
  if (inserts.length) await db.batch(inserts as [(typeof inserts)[0], ...typeof inserts]);
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Gate submits
// ---------------------------------------------------------------------------

/** Email-gate submit for a hosted file: capture the lead, set cookie, re-enter /f. */
router.post("/f/:short_code/unlock", async (c) => {
  const shortCode = c.req.param("short_code");
  const email = await formField(c, "email");
  const { domain, unknownHost } = await resolveHost(c);
  if (unknownHost) return text("File not found.", 404);
  const db = c.var.db;
  const asset = await lookupAsset(db, domain, { shortCode });
  if (!asset) return text("File not found.", 404);

  const brand = asset.branded && domain ? domain.hostname : null;
  if (!validEmail(email)) {
    return emailGatePage({ action: `/f/${shortCode}/unlock`, brand, error: true });
  }

  await captureLead(db, email, { ip: clientIp(c), fileId: asset.id });

  const resp = redirectResponse(`/f/${shortCode}`, 303);
  resp.headers.append(
    "set-cookie",
    starletteCookie(gateCookieName(shortCode), "1", { maxAge: GATE_COOKIE_MAX_AGE, httpOnly: true, sameSite: "lax" }),
  );
  return resp;
});

async function unlockCode(c: Ctx, ident: { shortCode: string } | { slug: string }): Promise<Response> {
  const code = await formField(c, "code");
  const { domain, unknownHost } = await resolveHost(c);
  if (unknownHost) return text("Page not found.", 404);
  const { db, settings } = c.var;
  const asset = await lookupAsset(db, domain, ident);
  if (!asset) return text("Page not found.", 404);
  const brand = asset.branded && domain ? domain.hostname : null;
  const back = asset.slug ? `/p/${asset.slug}` : `/f/${asset.shortCode}`;
  const action = `/f/${asset.shortCode}/unlock-code`;

  if (!asset.accessCodeHash) return redirectResponse(back, 303);

  const ip = clientIp(c);
  if (await codeAttemptLimited(c.env.DB, ip, asset.id)) {
    return codeGatePage({ action, brand, error: "too_many" });
  }

  if (!(await verifyAccessCode(settings, asset, code))) {
    await recordPageEvent(db, asset.id, PAGE_EVENT_GATE_FAILED, {
      ref: "code",
      visitorId: validVisitorId(getCookie(c, VISITOR_COOKIE)),
      ip,
    });
    return codeGatePage({ action, brand, error: "wrong" });
  }

  const resp = redirectResponse(back, 303);
  resp.headers.append(
    "set-cookie",
    starletteCookie(codeCookieName(asset.shortCode), await codeCookieValue(asset), {
      maxAge: GATE_COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps(c),
      path: "/",
    }),
  );
  return resp;
}

/** Access-code gate submit (Beam Pages): verify, set cookie, re-enter the page. */
router.post("/f/:short_code/unlock-code", (c) => unlockCode(c, { shortCode: c.req.param("short_code") }));
router.post("/p/:slug/unlock-code", (c) => unlockCode(c, { slug: c.req.param("slug").trim().toLowerCase() }));
