/**
 * Shared access-gate helpers for the redirect (/r) and file-serve (/f, /p)
 * paths. Port of backend/app/api/access_control.py.
 *
 * Enforcement lives at serve time so a link/file self-destructs, gates on email,
 * or blocks VPNs regardless of how it was shared. The per-view counting/expiry/
 * revoke gate for links is atomic in services/utm.ts `consumeLinkView`.
 *
 * Exports:
 *   clientIp(c: Context): string | null                     (CF-Connecting-IP, True-Client-IP, first X-Forwarded-For hop; never X-Real-IP)
 *   validEmail(email: string | null | undefined): boolean
 *   gateCookieName(code: string): string                    ("cbgate_<alnum code>")
 *   hasGateCookie(c: Context, code: string): boolean
 *   isVpnIp(deps: GeoDeps, ip: string | null, opts?: { cf?: CfGeo | null }): Promise<boolean>   (fails open)
 *   captureLead(db: Db, email: string, { ip, linkId?, fileId? }): Promise<void>
 *   ACCESS_CODE_RE, CODE_ATTEMPTS_PER_WINDOW (5), CODE_WINDOW_SECONDS (600)
 *   hashAccessCode(settings: Settings, pageId: string, code: string): Promise<string>     (HMAC-SHA256 hex)
 *   setAccessCode(settings, asset: { id; accessCodeHash }, code: string | null | undefined): Promise<string | null>
 *        (validates 4–8 digits -> 422 "Access code must be 4–8 digits."; sets asset.accessCodeHash in place and returns it;
 *         caller persists it)
 *   verifyAccessCode(settings, asset, code: string | null | undefined): Promise<boolean>
 *   codeCookieName(shortCode: string): string               ("cbcode_<alnum code>")
 *   codeCookieValue(asset: { id; accessCodeHash }): Promise<string>
 *   hasCodeCookie(c: Context, asset: { id; accessCodeHash; shortCode }): Promise<boolean>
 *   codeAttemptLimited(d1: D1Database, ip: string | null, pageId: string): Promise<boolean>   (fails open)
 */
import type { Context } from "hono";
import type { Db } from "../db/client";
import { accessLeads } from "../db/schema";
import type { Settings } from "../env";
import { type GeoDeps, lookupIp } from "../services/geoip";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "./crypto";
import { httpError } from "./errors";
import { incrWithTtl, windowIndex } from "./ratelimit";
import { type CfGeo, getCookie } from "./request";
import { nowIso } from "./time";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Headers the CDN sets to the true visitor IP, most authoritative first.
// CF-Connecting-IP is written by Cloudflare itself on every proxied request and
// cannot be forged by the visitor, unlike X-Forwarded-For. X-Real-IP is
// deliberately NOT consulted: behind a proxy it names the proxy, not the visitor.
const CLIENT_IP_HEADERS = ["cf-connecting-ip", "true-client-ip"];

/** Best-effort true client IP, for geo enrichment and VPN gating. */
export function clientIp(c: Context): string | null {
  const h = c.req.raw.headers;
  for (const name of CLIENT_IP_HEADERS) {
    const v = (h.get(name) ?? "").trim();
    if (v) return v;
  }
  const forwarded = (h.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return forwarded || null;
}

export function validEmail(email: string | null | undefined): boolean {
  return !!email && EMAIL_RE.test(email.trim()) && email.length <= 320;
}

// --- Email gate cookie -------------------------------------------------------
// A per-code marker set once the viewer submits an email. This is a lead-capture
// gate, not hard auth, so a simple cookie is the right weight. Namespaced so one
// code can't unlock another.

export function gateCookieName(code: string): string {
  return `cbgate_${code.replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
}

export function hasGateCookie(c: Context, code: string): boolean {
  return getCookie(c, gateCookieName(code)) === "1";
}

/**
 * Best-effort VPN/proxy check for block_vpn links/files, using the same geo
 * lookup as enrichment (pass `cf: cfGeo(c)`). Fails OPEN on any error so a
 * lookup outage never breaks legitimate access.
 */
export async function isVpnIp(deps: GeoDeps, ip: string | null, opts: { cf?: CfGeo | null } = {}): Promise<boolean> {
  if (!ip) return false;
  try {
    const geo = await lookupIp(deps, ip, opts);
    return !!geo?.is_vpn;
  } catch (err) {
    console.warn(`isVpnIp lookup failed for ${ip}`, err);
    return false;
  }
}

/** Store an email captured at the gate. */
export async function captureLead(
  db: Db,
  email: string,
  { ip, linkId = null, fileId = null }: { ip: string | null; linkId?: string | null; fileId?: string | null },
): Promise<void> {
  await db
    .insert(accessLeads)
    .values({
      id: crypto.randomUUID(),
      email: email.trim().slice(0, 320),
      ipAddress: ip || null,
      linkId,
      fileId,
      createdAt: nowIso(),
    })
    .run();
}

// --- Access-code gate (Beam Pages) ---------------------------------------------
// A 4–8 digit code is a 10^4–10^8 space: offline-brute-forceable under any
// unkeyed hash. A keyed HMAC makes a dump useless without the server secret;
// attempt limiting is the real defence.

export const ACCESS_CODE_RE = /^\d{4,8}$/;
export const CODE_ATTEMPTS_PER_WINDOW = 5;
export const CODE_WINDOW_SECONDS = 600;

function codeSecret(settings: Settings): string {
  return settings.resolvedUploadSecret || settings.storageUploadSecret || settings.clerkSecretKey || "champbeam-access-code";
}

export function hashAccessCode(settings: Settings, pageId: string, code: string): Promise<string> {
  return hmacSha256Hex(codeSecret(settings), `${pageId}:${code}`);
}

interface CodeAsset {
  id: string;
  accessCodeHash: string | null;
}

/** Set (validated) or clear (null/empty) a page's access code on `asset`; returns the new hash. */
export async function setAccessCode(
  settings: Settings,
  asset: CodeAsset,
  code: string | number | null | undefined,
): Promise<string | null> {
  if (code == null || String(code).trim() === "") {
    asset.accessCodeHash = null;
    return null;
  }
  const c = String(code).trim();
  if (!ACCESS_CODE_RE.test(c)) httpError(422, "Access code must be 4–8 digits.");
  asset.accessCodeHash = await hashAccessCode(settings, asset.id, c);
  return asset.accessCodeHash;
}

export async function verifyAccessCode(
  settings: Settings,
  asset: CodeAsset,
  code: string | null | undefined,
): Promise<boolean> {
  const c = (code ?? "").trim();
  if (!asset.accessCodeHash || !ACCESS_CODE_RE.test(c)) return false;
  return timingSafeEqual(await hashAccessCode(settings, asset.id, c), asset.accessCodeHash);
}

export function codeCookieName(shortCode: string): string {
  return `cbcode_${shortCode.replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
}

/** Derived from the current hash, so changing the code invalidates cookies. */
export async function codeCookieValue(asset: CodeAsset): Promise<string> {
  return (await sha256Hex(`${asset.id}:${asset.accessCodeHash}`)).slice(0, 32);
}

export async function hasCodeCookie(c: Context, asset: CodeAsset & { shortCode: string }): Promise<boolean> {
  if (!asset.accessCodeHash) return true;
  return getCookie(c, codeCookieName(asset.shortCode)) === (await codeCookieValue(asset));
}

/** True when this IP has exhausted its attempts for this page (fails open). */
export async function codeAttemptLimited(d1: D1Database, ip: string | null, pageId: string): Promise<boolean> {
  const window = windowIndex(CODE_WINDOW_SECONDS);
  const count = await incrWithTtl(d1, `code_rl:${pageId}:${ip || "-"}:${window}`, CODE_WINDOW_SECONDS);
  return count !== null && count > CODE_ATTEMPTS_PER_WINDOW;
}
