/**
 * A1 forward alerts: detect that a shared link or file reached someone new, store one alert per
 * forward for the asset owner, and build the context for a copy-only follow-up draft.
 * Nothing here sends anything to anyone: the draft is saved on the row and shown to the owner only.
 *
 * - isForwardEligible: the only place a raw click is judged human enough to count.
 * - detectForwards: pure rules over one asset's eligible clicks (cities, new_company).
 * - scanForwards: the 15-minute cron, re-evaluates assets with fresh clicks and inserts new alerts.
 * - followupContext / followupMessages / checkDraft: draft input and the privacy gate on its output.
 */
import { z } from "zod";
import type { Ctx, Env } from "../env";
import { buildRedirectUrl, domainHosts } from "../routes/_utmHelpers";
import { buildShareUrl } from "./content";
import { isHostingAsn } from "./geoip";
import type { ChatMessage } from "./assistant";

type Row = Record<string, any>;

export const MAX_ALERTS_PER_ASSET = 5;
const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;
const RECENT_MS = 20 * 60_000;
const MAX_ASSETS_PER_RUN = 200;
const MAX_EVENTS_PER_ASSET = 2000;
const MIN_TOPIC_DWELL_MS = 10_000;
const EXCLUDED_COMPANY_TYPES = ["isp", "hosting", "vpn"];
const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me"]);
export const PRIVACY_REJECT = "The draft broke a privacy rule. Try again.";

export interface Candidate {
  reason: "cities" | "new_company";
  dedupe_key: string;
  cities: string[];
  visitor_ids: string[];
  company_name: string | null;
  company_domain: string | null;
  evidence_event_id: string;
}

// J1 seam: when click_events.is_scanner lands (PR #63), add && !e.is_scanner here and select the column in scanForwards; nothing else in A1 reads raw clicks.
export function isForwardEligible(e: Row): boolean {
  return e.device_type !== "bot" && !e.is_vpn && !isHostingAsn(e.asn_org) && !!e.visitor_id;
}

/** "Mumbai, IN" for display; the distinct key is city|country_code. */
const cityLabel = (e: Row) => (e.country_code ? `${e.city}, ${e.country_code}` : String(e.city));

/** Domain of the owner's email, or null for free mail (a gmail owner excludes nobody). */
export function ownerDomainOf(email: string | null | undefined): string | null {
  const d = (email ?? "").split("@")[1]?.trim().toLowerCase();
  return d && !FREE_MAIL.has(d) ? d : null;
}

/** Forward candidates for ONE asset. `events` ascending by clicked_at, already limited to the window. */
export function detectForwards(events: Row[], ownerDomain: string | null): Candidate[] {
  const eligible = events.filter(isForwardEligible);
  const out: Candidate[] = [];

  // cities: the asset (not one visitor) reached 2+ places through 2+ visitors. A travelling person is one visitor.
  const cities = new Map<string, string>();
  const visitors = new Set<string>();
  for (const e of eligible) {
    if (e.city) cities.set(`${e.city}|${e.country_code ?? ""}`, cityLabel(e));
    visitors.add(e.visitor_id);
    if (cities.size >= 2 && visitors.size >= 2) {
      out.push({
        reason: "cities", dedupe_key: "cities", cities: [...cities.values()], visitor_ids: [...visitors],
        company_name: null, company_domain: null, evidence_event_id: e.id,
      });
      break;
    }
  }

  // new_company: the first company domain is the original recipient; each later distinct domain is a forward.
  const byDomain = new Map<string, Row[]>();
  for (const e of eligible) {
    const domain = String(e.company_domain ?? "").trim().toLowerCase();
    if (!domain || domain === ownerDomain || EXCLUDED_COMPANY_TYPES.includes(String(e.company_type ?? "").toLowerCase())) continue;
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), e]);
  }
  for (const [domain, rows] of [...byDomain].slice(1)) {
    out.push({
      reason: "new_company", dedupe_key: `company:${domain}`,
      cities: [...new Set(rows.filter((e) => e.city).map(cityLabel))], visitor_ids: [...new Set(rows.map((e) => e.visitor_id))],
      company_name: rows.find((e) => e.company_name)?.company_name ?? null, company_domain: domain, evidence_event_id: rows[0].id,
    });
  }
  return out.slice(0, MAX_ALERTS_PER_ASSET);
}

const all = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<Row[]> =>
  (await db.prepare(sql).bind(...binds).all<Row>()).results ?? [];

const EVENT_COLS = "id, visitor_id, city, country_code, is_vpn, asn_org, company_name, company_domain, company_type, device_type, clicked_at";

/** Cron: re-evaluate every asset with an eligible click in the last 20 minutes. Returns the number of alerts inserted. */
// shortcut: a cron outage over 20 minutes misses those forwards, upgrade to a stored watermark if alerts go missing.
export async function scanForwards(env: Env, now: Date = new Date()): Promise<number> {
  const db = env.DB;
  const recent = await all(
    db,
    `SELECT link_id, file_id, visitor_id, device_type, is_vpn, asn_org FROM click_events
     WHERE clicked_at >= ? ORDER BY clicked_at DESC LIMIT 5000`,
    new Date(now.getTime() - RECENT_MS).toISOString(),
  );
  const assets = new Map<string, { type: "link" | "file"; id: string }>();
  for (const e of recent) {
    if (assets.size >= MAX_ASSETS_PER_RUN) break;
    if (!isForwardEligible(e)) continue;
    const a = e.link_id ? { type: "link" as const, id: e.link_id } : e.file_id ? { type: "file" as const, id: e.file_id } : null;
    if (a) assets.set(`${a.type}:${a.id}`, a);
  }

  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  let inserted = 0;
  for (const a of assets.values()) {
    const [owner] = await all(
      db,
      a.type === "link"
        ? "SELECT x.user_id, x.organization_id, u.email FROM link_clicks x JOIN users u ON u.id = x.user_id WHERE x.id = ?"
        : "SELECT x.user_id, x.organization_id, u.email FROM file_assets x JOIN users u ON u.id = x.user_id WHERE x.id = ? AND x.status != 'deleted'",
      a.id,
    );
    if (!owner) continue; // deleted file or ownerless asset
    const have = new Set(
      (await all(db, "SELECT dedupe_key FROM forward_alerts WHERE asset_type = ? AND asset_id = ?", a.type, a.id)).map((r) => r.dedupe_key),
    );
    if (have.size >= MAX_ALERTS_PER_ASSET) continue;
    // Newest 2000, replayed oldest first, so fresh clicks are always in view on a busy asset.
    // id breaks clicked_at ties, so every scan agrees on which company came first.
    const events = (
      await all(
        db,
        `SELECT ${EVENT_COLS} FROM click_events WHERE ${a.type}_id = ? AND clicked_at >= ? ORDER BY clicked_at DESC, id DESC LIMIT ?`,
        a.id, since, MAX_EVENTS_PER_ASSET,
      )
    ).reverse();
    const fresh = detectForwards(events, ownerDomainOf(owner.email))
      .filter((cand) => !have.has(cand.dedupe_key))
      .slice(0, MAX_ALERTS_PER_ASSET - have.size);
    if (!fresh.length) continue;
    const res = await db.batch(
      fresh.map((cand) =>
        db
          .prepare(
            `INSERT INTO forward_alerts (id, user_id, organization_id, asset_type, asset_id, reason, dedupe_key, cities, visitor_ids,
               company_name, company_domain, evidence_event_id, detected_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (asset_type, asset_id, dedupe_key) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(), owner.user_id, owner.organization_id ?? null, a.type, a.id, cand.reason, cand.dedupe_key,
            JSON.stringify(cand.cities), JSON.stringify(cand.visitor_ids), cand.company_name, cand.company_domain,
            cand.evidence_event_id, now.toISOString(),
          ),
      ),
    );
    inserted += res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }
  return inserted;
}

// ---- follow-up context --------------------------------------------------------------------------

export interface Topic {
  id: string;
  title: string;
  dwell_ms: number;
  storage_key: string;
}

const parseList = (v: unknown): string[] => {
  try {
    const x = JSON.parse(String(v ?? "[]"));
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};
export const alertCities = (alert: Row) => parseList(alert.cities);
export const alertVisitors = (alert: Row) => parseList(alert.visitor_ids);

/** Same title rule as routes/pages.ts titleFromFilename. */
const pageTitle = (filename: string) => filename.replace(/\.html?$/i, "").replace(/-/g, " ") || "Untitled page";

/** The asset an alert points at, title and URL built the way routes/journeys.ts:93-95 builds them. */
export async function alertAsset(c: Ctx, alert: Row): Promise<{ type: "link" | "file"; id: string; title: string; url: string }> {
  const type = alert.asset_type as "link" | "file";
  const [x] = await all(
    c.env.DB,
    type === "link"
      ? "SELECT anchor_text, original_url, short_code, domain_id FROM link_clicks WHERE id = ? AND user_id = ?"
      : "SELECT filename, short_code, domain_id FROM file_assets WHERE id = ? AND user_id = ? AND status != 'deleted'",
    alert.asset_id, alert.user_id,
  );
  if (!x) return { type, id: alert.asset_id, title: type === "link" ? "Deleted link" : "Deleted file", url: "" };
  const host = (await domainHosts(c, [x.domain_id])).get(x.domain_id);
  return type === "link"
    ? { type, id: alert.asset_id, title: x.anchor_text || x.original_url, url: buildRedirectUrl(c, x.short_code, host) ?? "" }
    : {
        type, id: alert.asset_id, title: x.filename,
        url: buildShareUrl(c.var.settings, { file: { shortCode: x.short_code, filename: x.filename }, hostname: host }),
      };
}

/** Up to 3 of the owner's HTML Pages the alert's visitors spent 10s+ on in the last 30 days, most dwell first. */
export async function alertTopics(db: D1Database, alert: Row, now: Date = new Date()): Promise<Topic[]> {
  const rows = await all(
    db,
    `SELECT fa.id, fa.filename, fa.storage_key, SUM(pe.dwell_ms) AS dwell
     FROM page_engagements pe JOIN file_assets fa ON fa.id = pe.file_id
     WHERE fa.user_id = ? AND fa.kind = 'html' AND fa.status != 'deleted'
       AND pe.visitor_id IN (SELECT value FROM json_each(?)) AND pe.created_at >= ?
     GROUP BY fa.id HAVING SUM(pe.dwell_ms) >= ? ORDER BY dwell DESC LIMIT 3`,
    alert.user_id, JSON.stringify(alertVisitors(alert)), new Date(now.getTime() - WINDOW_MS).toISOString(), MIN_TOPIC_DWELL_MS,
  );
  return rows.map((r) => ({ id: r.id, title: pageTitle(r.filename), dwell_ms: Number(r.dwell), storage_key: r.storage_key }));
}

const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/** Owner-only notes, built by code. These never go into a model message. */
export function senderNotes(alert: Row, topics: Topic[]): string[] {
  const notes: string[] = [];
  const cities = alertCities(alert);
  const n = alertVisitors(alert).length;
  if (alert.reason === "cities") notes.push(`Opened by ${n} visitor${n === 1 ? "" : "s"} in ${listJoin(cities)}`);
  else notes.push(alert.company_name ? `New company: ${alert.company_name} (${alert.company_domain})` : `New company: ${alert.company_domain}`);
  for (const t of topics) notes.push(`${duration(t.dwell_ms)} on "${t.title}" (page)`);
  return notes;
}

/** Tag-stripped text of a page's current version, first 600 characters. Missing object = empty. */
async function excerpt(env: Env, key: string): Promise<string> {
  try {
    const html = (await (await env.FILES.get(key))?.text()) ?? "";
    return html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
  } catch {
    return "";
  }
}

export async function followupContext(c: Ctx, alert: Row) {
  const [asset, topics] = await Promise.all([alertAsset(c, alert), alertTopics(c.env.DB, alert)]);
  const withText = await Promise.all(topics.map(async (t) => ({ title: t.title, excerpt: await excerpt(c.env, t.storage_key) })));
  return { asset, topics: withText, sender_notes: senderNotes(alert, topics) };
}

const SYSTEM_PROMPT =
  'You draft a short follow-up email from the sender to the person they shared "{asset_title}" with. Write as the sender, plain text. Start with exactly "Hi {first_name},". Under 120 words. Offer to walk them and any colleagues through it, and end with one clear question. You may steer toward the TOPICS given, but never say or imply that you know what they read, opened, viewed, forwarded, how long they spent, where they are, or who else saw it. Do not invent names, numbers, dates, or claims. Return JSON: {"subject": string, "body": string}.';

/** Model input: asset title and topic text only. No dwell, cities, visitor counts or company. */
export function followupMessages(ctx: { asset: { type: string; title: string }; topics: { title: string; excerpt: string }[] }): ChatMessage[] {
  const topics = ctx.topics.length ? ctx.topics.map((t, i) => `${i + 1}. ${t.title}: ${t.excerpt}`).join("\n") : "(none)";
  return [
    { role: "system", content: SYSTEM_PROMPT.replace("{asset_title}", ctx.asset.title) },
    { role: "user", content: `Shared ${ctx.asset.type}: "${ctx.asset.title}"\n\nTOPICS:\n${topics}` },
  ];
}

const Draft = z.object({ subject: z.string().min(3).max(120), body: z.string().min(20).max(1200) });
const LEAK = /\b(track|tracked|tracking|viewed|opened|forward|forwarded|dwell|read receipt|i (saw|noticed|see))\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The privacy gate on a model reply: the parsed draft, or null when it must be rejected. */
export function checkDraft(reply: string, cities: string[]): { subject: string; body: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return null;
  }
  const d = Draft.safeParse(parsed);
  if (!d.success || !d.data.body.startsWith("Hi {first_name},")) return null;
  const text = `${d.data.subject}\n${d.data.body}`;
  if (LEAK.test(text)) return null;
  const names = cities.map((x) => x.split(",")[0].trim()).filter(Boolean);
  if (names.some((name) => new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(text))) return null;
  return { subject: d.data.subject, body: d.data.body };
}
