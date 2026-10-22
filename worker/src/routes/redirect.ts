/**
 * Redirect endpoint for tracked short links. Port of backend/app/api/redirect.py
 * — mounted at / (/r/{short_code}).
 *
 * Exports `redirectLink(c, shortCode)` so /s/{short_code} (shortLinks.ts) is a
 * full alias of /r.
 */
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Ctx, Settings } from "../env";
import type { Db } from "../db/client";
import { linkClicks } from "../db/schema";
import { captureLead, clientIp, gateCookieName, hasGateCookie, isVpnIp, validEmail } from "../lib/accessControl";
import { blockedPage, emailGatePage } from "../lib/accessPages";
import { cfGeo } from "../lib/request";
import { isPast } from "../lib/time";
import { type Domain, requestHost, resolveDomain } from "../services/assetLookup";
import {
  captureVisit,
  consumeLinkView,
  insertClickEvent,
  type LinkClick,
  type LinkViewStatus,
  scheduleGeoEnrichment,
} from "../services/utm";
import { formField, redirectResponse, starletteCookie } from "./_serveCommon";
import { ChampVault, deliveryTarget } from "./_champvault";

export const router = new Hono<AppEnv>({ strict: false });

const GATE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

async function findLink(db: Db, domain: Domain | null, shortCode: string): Promise<LinkClick | null> {
  const row = await db
    .select()
    .from(linkClicks)
    .where(
      and(
        eq(linkClicks.shortCode, shortCode),
        domain === null ? isNull(linkClicks.domainId) : eq(linkClicks.domainId, domain.id),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Where this link should send the visitor.
 *
 * For a ChampVault-backed beam, re-mint a fresh (short-lived) delivery URL on
 * each open so the link never dies when a previously-minted URL expires; fall
 * back to the last-known `tracked_url` if ChampVault is unreachable. The
 * `champvault://` pseudo original_url is never a valid destination.
 */
async function resolveDestination(settings: Settings, link: LinkClick): Promise<string | null> {
  let destination: string | null = link.trackedUrl || link.originalUrl;
  if (link.champvaultAssetId) {
    if (settings.champvaultConfigured) {
      try {
        const delivered = await new ChampVault(settings).deliver(link.champvaultAssetId, 3600, { timeoutMs: 6000 });
        const fresh = deliveryTarget(delivered);
        if (fresh) destination = fresh;
      } catch (err) {
        console.warn(`champvault re-mint failed for asset=${link.champvaultAssetId}; using last-known URL`, err);
      }
    }
    if (destination && destination.startsWith("champvault://")) destination = null;
  }
  return destination || null;
}

/**
 * Redirect a short code to its destination, recording the click.
 *
 * The Host header decides which short-code namespace to look in: the platform
 * default uses `domain_id IS NULL`; a custom hostname must resolve to an
 * `active` Domain row and then look up by `(domain_id, short_code)`.
 */
export async function redirectLink(c: Ctx, shortCode: string): Promise<Response> {
  const { db, settings } = c.var;
  const host = requestHost(c);
  const domain = await resolveDomain(db, settings, host);

  if (host && domain === null && !settings.isPlatformHost(host)) {
    // Custom hostname that isn't registered or isn't active: refuse rather than
    // fall through to the platform-default bucket (which would leak one
    // tenant's link onto another tenant's domain).
    return redirectResponse("/", 302);
  }

  const link = await findLink(db, domain, shortCode);
  if (!link) return redirectResponse("/", 302);

  const ip = clientIp(c);
  // Branded pages carry the sender's custom domain when they have one.
  const brand = link.branded && domain ? domain.hostname : null;

  // --- Access gates (before counting a view) ---------------------------
  // 1. Email gate: capture a lead before granting access.
  if (link.requireEmail && !hasGateCookie(c, shortCode)) {
    return emailGatePage({ action: `/r/${shortCode}/unlock`, brand });
  }
  // 2. VPN/proxy block.
  if (link.blockVpn && (await isVpnIp({ settings, db }, ip, { cf: cfGeo(c) }))) {
    return blockedPage("vpn", { brand });
  }
  // 3. Self-destruct checks on the already-loaded row — enforced even if the
  //    counter write below fails (the redirect must survive tracking outages,
  //    but revoked/expired links must still be blocked).
  if (link.revokedAt != null) return blockedPage("revoked", { brand });
  if (isPast(link.expiresAt)) return blockedPage("expired", { brand });
  // 4. Atomic view cap + count. Fail open on a DB/tracking failure (the cap
  //    needs the DB; revoke/expiry above are already enforced).
  let status: LinkViewStatus;
  try {
    status = await consumeLinkView(db, link.id, ip);
  } catch (err) {
    console.error(`redirect: view gate failed for short_code=${shortCode}`, err);
    status = "ok";
  }
  if (status !== "ok") return blockedPage(status, { brand });

  const destination = await resolveDestination(settings, link);
  if (!destination) return redirectResponse("/", 302);

  // Best-effort event insert (the view was already counted atomically above).
  try {
    const visit = captureVisit(c, ip);
    const eventId = await insertClickEvent(db, {
      linkId: link.id,
      ipAddress: ip,
      userAgent: visit.userAgent,
      referrer: visit.referrer,
      domainId: domain ? domain.id : null,
    });
    if (eventId && ip) scheduleGeoEnrichment(c, eventId, visit);
  } catch (err) {
    console.error(`redirect: click event insert failed for short_code=${shortCode} link_id=${link.id}`, err);
  }

  return redirectResponse(destination, 302);
}

router.get("/r/:short_code", (c) => redirectLink(c, c.req.param("short_code")));

/** Email-gate submit: capture the lead, set the gate cookie, re-enter /r. */
router.post("/r/:short_code/unlock", async (c) => {
  const { db, settings } = c.var;
  const shortCode = c.req.param("short_code");
  const email = await formField(c, "email");
  const domain = await resolveDomain(db, settings, requestHost(c));
  const link = await findLink(db, domain, shortCode);
  if (!link) return redirectResponse("/", 302);

  const brand = link.branded && domain ? domain.hostname : null;
  if (!validEmail(email)) {
    return emailGatePage({ action: `/r/${shortCode}/unlock`, brand, error: true });
  }

  await captureLead(db, email, { ip: clientIp(c), linkId: link.id });

  const resp = redirectResponse(`/r/${shortCode}`, 303);
  resp.headers.append(
    "set-cookie",
    starletteCookie(gateCookieName(shortCode), "1", { maxAge: GATE_COOKIE_MAX_AGE, httpOnly: true, sameSite: "lax" }),
  );
  return resp;
});
