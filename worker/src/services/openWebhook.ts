/**
 * "Link opened" webhook for contact-bound links (link_clicks.contact_ref).
 *
 * Fires from the post-response enrichment task, so geo/ASN/company are already
 * on the event row. Skips anonymous links, UA-identified bots (link previews,
 * crawlers) and unconfigured deployments. Body is signed with HMAC-SHA256 over
 * the raw bytes: header `X-Beam-Signature: sha256=<hex>`.
 *
 * shortcut: one attempt, 5s timeout, failure only logged. Upgrade to a Queue
 * with retries when the receiver is not on the same trust boundary.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { clickEvents, linkClicks } from "../db/schema";
import { bytesToHex, hmacSha256 } from "../lib/crypto";
import type { GeoDeps } from "./geoip";
import { isHostingAsn } from "./geoip";

export type NotifyDeps = GeoDeps & { db: Db; openWebhook?: Fetcher };

export async function notifyOpen(deps: NotifyDeps, eventId: string): Promise<void> {
  const { openWebhookUrl, openWebhookSecret } = deps.settings;
  if (!openWebhookUrl || !openWebhookSecret) return;

  const row = await deps.db
    .select({ e: clickEvents, l: linkClicks })
    .from(clickEvents)
    .innerJoin(linkClicks, eq(clickEvents.linkId, linkClicks.id))
    .where(eq(clickEvents.id, eventId))
    .get();
  if (!row || !row.l.contactRef || row.e.deviceType === "bot") return;

  const { e, l } = row;
  const body = JSON.stringify({
    event: "link.opened",
    event_id: e.id,
    contact_ref: l.contactRef,
    link_id: l.id,
    short_code: l.shortCode,
    destination: l.originalUrl,
    utm_campaign: l.utmCampaign,
    clicked_at: e.clickedAt,
    ip: e.ipAddress,
    user_agent: e.userAgent,
    device: { type: e.deviceType, browser: e.browser, os: e.os },
    geo: { country_code: e.countryCode, region: e.region, city: e.city },
    network: { asn_org: e.asnOrg, is_vpn: !!e.isVpn },
    company: { name: e.companyName, domain: e.companyDomain, industry: e.companyIndustry, size: e.companySize },
    // Mail/security scanners click from datacenter ASNs with ordinary browser UAs.
    likely_scanner: isHostingAsn(e.asnOrg),
  });
  const sig = bytesToHex(await hmacSha256(openWebhookSecret, body));
  const f = deps.openWebhook ? deps.openWebhook.fetch.bind(deps.openWebhook) : deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const resp = await f(openWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Beam-Event-Id": e.id, "X-Beam-Signature": `sha256=${sig}` },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (resp.status >= 400) console.warn(`open webhook ${e.id} -> ${resp.status}`);
}
