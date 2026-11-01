/**
 * Port of backend/app/api/v1/utm.py — mounted at /api/v1/utm.
 *
 * Preset CRUD, link generation, bulk CSV processing, link access controls,
 * tags; the /analytics/* endpoints live in ./_utmAnalytics.ts and are
 * registered on this same router.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { getCurrentUser, requireAuth, type TokenData } from "../auth/security";
import {
  accessLeads,
  clickEvents,
  DOMAIN_STATUS_ACTIVE,
  domains,
  linkClicks,
  linkTagAssociations,
  linkTags,
  utmPresets,
} from "../db/schema";
import { httpError, HTTPError } from "../lib/errors";
import { requestOrigin } from "../lib/request";
import { isoUtc, nowIso, parseIso } from "../lib/time";
import { parseJson, parseQuery, qStr } from "../lib/validate";
import { assertCanShare, defaultDomainFor, findUsableDomain, shareOrgUuid } from "../services/domains";
import { generateUtmUrl, processBulkCsv, recordLink, UTM_KEYS, type LinkClick, type UtmParams } from "../services/utm";
import { buildRedirectUrl, getUserLink, normUuid } from "./_utmHelpers";
import { registerAnalytics } from "./_utmAnalytics";

export const router = new Hono<AppEnv>({ strict: false });

// ============================================================================
// Request models
// ============================================================================

const optStr = z.string().nullable().optional();

const UTMPresetCreate = z.object({
  name: z.string(),
  is_shared: z.boolean().default(false),
  utm_source: z.string().default(""),
  utm_medium: z.string().default(""),
  utm_campaign: z.string().default(""),
  utm_content: optStr,
  utm_term: optStr,
  custom_params: z.record(z.string(), z.unknown()).nullable().optional(),
});

const UTMPresetUpdate = z.object({
  name: optStr,
  is_shared: z.boolean().nullable().optional(),
  utm_source: optStr,
  utm_medium: optStr,
  utm_campaign: optStr,
  utm_content: optStr,
  utm_term: optStr,
  custom_params: z.record(z.string(), z.unknown()).nullable().optional(),
});

const GenerateLinkRequest = z.object({
  base_url: optStr,
  // Accepted alias for base_url (integration clients commonly send "url").
  url: optStr,
  utm_source: optStr,
  utm_medium: optStr,
  utm_campaign: optStr,
  utm_content: optStr,
  utm_term: optStr,
  project_name: optStr,
  project_id: optStr,
  preset_id: optStr,
  domain_id: optStr,
  // Binds the link to one external contact; opens are then reported by webhook.
  contact_ref: z.string().trim().min(1).max(128).nullable().optional(),
});

const UpdateLinkRequest = z.object({ project_id: optStr });

const optInt = z.number().int().nullable().optional();
const optBool = z.boolean().nullable().optional();
const LinkAccessRequest = z.object({
  // Only sent fields apply; for int limits send 0 to clear, positive to set.
  expires_in_hours: optInt,
  max_views: optInt,
  require_email: optBool,
  block_vpn: optBool,
  branded: optBool,
  revoked: optBool,
});

// ============================================================================
// Helpers
// ============================================================================

type Preset = typeof utmPresets.$inferSelect;
type Domain = typeof domains.$inferSelect;

function presetToResponse(p: Preset) {
  return {
    id: p.id,
    user_id: p.userId,
    name: p.name,
    is_default: p.isDefault ?? false,
    is_shared: p.isShared ?? false,
    utm_source: p.utmSource,
    utm_medium: p.utmMedium,
    utm_campaign: p.utmCampaign,
    utm_content: p.utmContent,
    utm_term: p.utmTerm,
    custom_params: p.customParams ?? null,
    created_at: isoUtc(p.createdAt) ?? "",
  };
}

async function ownPreset(c: Ctx, presetId: string | null | undefined, userId: string): Promise<Preset | undefined> {
  const id = normUuid(presetId);
  if (!id) return undefined;
  return c.var.db
    .select()
    .from(utmPresets)
    .where(and(eq(utmPresets.id, id), eq(utmPresets.userId, userId)))
    .get();
}

async function requirePreset(c: Ctx, userId: string): Promise<Preset> {
  const p = await ownPreset(c, c.req.param("preset_id"), userId);
  if (!p) httpError(404, "UTM preset not found");
  return p!;
}

function presetParams(p: Preset | undefined): UtmParams {
  const out: UtmParams = {};
  if (!p) return out;
  const vals: Record<string, string | null> = {
    utm_source: p.utmSource,
    utm_medium: p.utmMedium,
    utm_campaign: p.utmCampaign,
    utm_content: p.utmContent,
    utm_term: p.utmTerm,
  };
  for (const k of UTM_KEYS) if (vals[k]) out[k] = vals[k];
  return out;
}

/**
 * `_resolve_link_domain`: an explicit domain_id must be the user's and active;
 * otherwise the user's active primary domain (or none -> platform default).
 */
async function resolveLinkDomain(c: Ctx, user: TokenData, domainId: string | null | undefined): Promise<Domain | null> {
  const db = c.var.db;
  const userId = user.userId;
  if (domainId) {
    const id = normUuid(domainId);
    if (!id) httpError(400, "Invalid domain_id.");
    const d = await findUsableDomain(db, userId, shareOrgUuid(user), id!);
    if (!d) httpError(404, "Active domain not found.");
    return d!;
  }
  return defaultDomainFor(db, user);
}

/** Parse a link-id path param for the delete/patch endpoints (400 "Invalid link ID."). */
function linkIdOr400(c: Ctx, detail: string): string {
  const id = normUuid(c.req.param("link_id"));
  if (!id) httpError(400, detail);
  return id!;
}

// ============================================================================
// Link generation (public endpoint, auth optional)
// ============================================================================

router.post("/generate", async (c) => {
  const user = await getCurrentUser(c);
  const data = await parseJson(c, GenerateLinkRequest);
  const baseUrl = (data.base_url || data.url || "").trim();
  if (!baseUrl) httpError(422, "base_url (or url) is required.");

  const utmParams: UtmParams = {};
  // If preset_id provided, load preset values as base
  if (data.preset_id && user) Object.assign(utmParams, presetParams(await ownPreset(c, data.preset_id, user.userId)));
  // Request-level params override preset
  for (const k of UTM_KEYS) {
    const v = data[k];
    if (v) utmParams[k] = v;
  }

  const trackedUrl = generateUtmUrl(baseUrl, utmParams);

  let linkId: string | null = null;
  let shortCode: string | null = null;
  let redirectUrl: string | null = null;
  let shortUrl: string | null = null;
  if (user) {
    let projectId: string | null = null;
    if (data.project_id) {
      projectId = normUuid(data.project_id);
      if (!projectId) httpError(400, "Invalid project_id.");
    }
    const domain = await resolveLinkDomain(c, user, data.domain_id);
    assertCanShare(user);
    const link = await recordLink(c.var.db, {
      userId: user.userId,
      organizationId: shareOrgUuid(user),
      originalUrl: baseUrl,
      trackedUrl,
      utmParams,
      projectName: data.project_name ?? null,
      projectId,
      domainId: domain?.id ?? null,
      contactRef: data.contact_ref ?? null,
    });
    linkId = link.id;
    shortCode = link.shortCode;
    redirectUrl = buildRedirectUrl(c, link.shortCode, domain?.hostname);
    if (link.shortCode) {
      // Short URL mirrors the redirect URL's host precedence: custom domain ->
      // configured redirect base (canonical public host, which server-to-server
      // API callers may not be hitting) -> request host.
      const override = c.var.settings.redirectBaseUrl;
      if (domain) shortUrl = `https://${domain.hostname}/s/${link.shortCode}`;
      else if (override) shortUrl = `${override.replace(/\/+$/, "")}/s/${link.shortCode}`;
      else shortUrl = `${requestOrigin(c)}/s/${link.shortCode}`;
    }
  }

  return c.json({
    original_url: baseUrl,
    tracked_url: trackedUrl,
    redirect_url: redirectUrl,
    short_code: shortCode,
    utm_params: utmParams,
    link_id: linkId,
    short_url: shortUrl,
  });
});

// ============================================================================
// Link management (auth required)
// ============================================================================

router.delete("/links/:link_id", async (c) => {
  const user = await requireAuth(c);
  const id = linkIdOr400(c, "Invalid link ID.");
  const db = c.var.db;
  const link = await db
    .select({ id: linkClicks.id })
    .from(linkClicks)
    .where(and(eq(linkClicks.id, id), eq(linkClicks.userId, user.userId)))
    .get();
  if (!link) httpError(404, "Link not found.");
  // Delete associated click events first, then the link, atomically.
  await db.batch([db.delete(clickEvents).where(eq(clickEvents.linkId, id)), db.delete(linkClicks).where(eq(linkClicks.id, id))]);
  return c.body(null, 204);
});

router.patch("/links/:link_id", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, UpdateLinkRequest);
  const id = linkIdOr400(c, "Invalid link ID.");
  const db = c.var.db;
  const where = and(eq(linkClicks.id, id), eq(linkClicks.userId, user.userId));
  let link = await db.select().from(linkClicks).where(where).get();
  if (!link) httpError(404, "Link not found.");

  if (data.project_id !== undefined && data.project_id !== null) {
    let projectId: string | null = null;
    if (data.project_id) {
      projectId = normUuid(data.project_id);
      if (!projectId) httpError(400, "Invalid project_id.");
    }
    await db.update(linkClicks).set({ projectId }).where(where).run();
    link = await db.select().from(linkClicks).where(where).get();
  }
  return c.json({
    id: link!.id,
    project_id: link!.projectId ?? null,
    original_url: link!.originalUrl,
    short_code: link!.shortCode,
  });
});

// ============================================================================
// Bulk CSV processing (auth required)
// ============================================================================

router.post("/bulk/generate", async (c) => {
  const user = await requireAuth(c);
  const q = parseQuery(c, z.object({ preset_id: qStr() }));
  let file: unknown;
  try {
    file = (await c.req.parseBody())["file"];
  } catch {
    file = undefined;
  }
  if (!(file instanceof File)) {
    throw new HTTPError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }]);
  }
  if (!file.name || !file.name.endsWith(".csv")) httpError(400, "File must be a CSV");

  const csvContent = new TextDecoder("utf-8").decode(await file.arrayBuffer());

  // Build default params from preset if provided
  const defaultParams = q.preset_id ? presetParams(await ownPreset(c, q.preset_id, user.userId)) : {};

  let resultCsv: string;
  try {
    resultCsv = await processBulkCsv(csvContent, defaultParams, {
      db: c.var.db,
      userId: user.userId,
      shortLinkBuilder: (code) => buildRedirectUrl(c, code),
    });
  } catch (e) {
    if (e instanceof HTTPError) throw e;
    httpError(400, (e as Error).message);
  }
  return new Response(resultCsv!, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=utm_links.csv" },
  });
});

router.get("/bulk/template", (c) => {
  const template =
    "url,utm_source,utm_medium,utm_campaign,utm_content,utm_term\nhttps://example.com,google,cpc,summer-sale,,\n";
  return new Response(template, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=utm_template.csv" },
  });
});

// ============================================================================
// Presets (auth required)
// ============================================================================

router.get("/presets", async (c) => {
  const user = await requireAuth(c);
  const rows = await c.var.db
    .select()
    .from(utmPresets)
    .where(or(eq(utmPresets.userId, user.userId), eq(utmPresets.isShared, true)))
    .orderBy(desc(utmPresets.createdAt))
    .all();
  return c.json(rows.map(presetToResponse));
});

router.post("/presets", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, UTMPresetCreate);
  const now = nowIso();
  const preset = await c.var.db
    .insert(utmPresets)
    .values({
      id: crypto.randomUUID(),
      userId: user.userId,
      name: data.name,
      isDefault: false,
      isShared: data.is_shared,
      utmSource: data.utm_source,
      utmMedium: data.utm_medium,
      utmCampaign: data.utm_campaign,
      utmContent: data.utm_content ?? null,
      utmTerm: data.utm_term ?? null,
      customParams: data.custom_params ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return c.json(presetToResponse(preset), 201);
});

router.get("/presets/:preset_id", async (c) => {
  const user = await requireAuth(c);
  return c.json(presetToResponse(await requirePreset(c, user.userId)));
});

router.put("/presets/:preset_id", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, UTMPresetUpdate);
  const preset = await requirePreset(c, user.userId);
  // model_dump(exclude_unset=True): only keys the client sent (null included).
  const map: Record<string, keyof Preset> = {
    name: "name",
    is_shared: "isShared",
    utm_source: "utmSource",
    utm_medium: "utmMedium",
    utm_campaign: "utmCampaign",
    utm_content: "utmContent",
    utm_term: "utmTerm",
    custom_params: "customParams",
  };
  const set: Record<string, unknown> = { updatedAt: nowIso() };
  for (const [k, prop] of Object.entries(map)) {
    if (k in data) set[prop] = (data as Record<string, unknown>)[k] ?? null;
  }
  const updated = await c.var.db
    .update(utmPresets)
    .set(set as Partial<Preset>)
    .where(eq(utmPresets.id, preset.id))
    .returning()
    .get();
  return c.json(presetToResponse(updated));
});

router.delete("/presets/:preset_id", async (c) => {
  const user = await requireAuth(c);
  const preset = await requirePreset(c, user.userId);
  await c.var.db.delete(utmPresets).where(eq(utmPresets.id, preset.id)).run();
  return c.body(null, 204);
});

router.post("/presets/:preset_id/default", async (c) => {
  const user = await requireAuth(c);
  const preset = await requirePreset(c, user.userId);
  const db = c.var.db;
  // Clear is_default on all the user's presets, then set this one.
  await db.batch([
    db.update(utmPresets).set({ isDefault: false }).where(eq(utmPresets.userId, user.userId)),
    db.update(utmPresets).set({ isDefault: true, updatedAt: nowIso() }).where(eq(utmPresets.id, preset.id)),
  ]);
  const fresh = await db.select().from(utmPresets).where(eq(utmPresets.id, preset.id)).get();
  return c.json(presetToResponse(fresh!));
});

// ============================================================================
// Link access controls (self-destruct, email gate, VPN block, branding)
// ============================================================================

async function getOwnedLink(c: Ctx, userId: string): Promise<LinkClick> {
  const id = normUuid(c.req.param("link_id"));
  if (!id) httpError(400, "Invalid link id.");
  const link = await c.var.db
    .select()
    .from(linkClicks)
    .where(and(eq(linkClicks.id, id!), eq(linkClicks.userId, userId)))
    .get();
  if (!link) httpError(404, "Link not found.");
  return link!;
}

function linkAccessStatus(link: LinkClick): string {
  const now = Date.now();
  const views = link.clickCount ?? 0;
  const exp = parseIso(link.expiresAt);
  const expired =
    link.revokedAt != null || (exp != null && exp.getTime() < now) || (link.maxViews != null && views >= link.maxViews);
  if (expired) return "expired";
  if (link.expiresAt != null || link.maxViews != null || link.revokedAt != null) return "expiring";
  return "tracking";
}

function linkAccessResponse(link: LinkClick) {
  const views = link.clickCount ?? 0;
  return {
    link_id: link.id,
    expires_at: isoUtc(link.expiresAt),
    max_views: link.maxViews ?? null,
    remaining_views: link.maxViews != null ? Math.max(0, link.maxViews - views) : null,
    require_email: !!link.requireEmail,
    block_vpn: !!link.blockVpn,
    branded: !!link.branded,
    revoked: link.revokedAt != null,
    access_status: linkAccessStatus(link),
    views,
  };
}

router.put("/links/:link_id/access", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, LinkAccessRequest);
  const link = await getOwnedLink(c, user.userId);
  const sent = (k: string) => k in data;
  const now = nowIso();
  const set: Partial<LinkClick> = {};
  if (sent("expires_in_hours")) {
    set.expiresAt = data.expires_in_hours
      ? new Date(Date.parse(now) + data.expires_in_hours * 3_600_000).toISOString()
      : null;
  }
  if (sent("max_views")) set.maxViews = data.max_views && data.max_views > 0 ? data.max_views : null;
  if (sent("require_email")) set.requireEmail = !!data.require_email;
  if (sent("block_vpn")) set.blockVpn = !!data.block_vpn;
  if (sent("branded")) set.branded = !!data.branded;
  if (sent("revoked")) set.revokedAt = data.revoked ? now : null;
  const db = c.var.db;
  if (Object.keys(set).length) await db.update(linkClicks).set(set).where(eq(linkClicks.id, link.id)).run();
  const fresh = await db.select().from(linkClicks).where(eq(linkClicks.id, link.id)).get();
  return c.json(linkAccessResponse(fresh!));
});

router.get("/links/:link_id/access", async (c) => {
  const user = await requireAuth(c);
  return c.json(linkAccessResponse(await getOwnedLink(c, user.userId)));
});

router.get("/links/:link_id/leads", async (c) => {
  const user = await requireAuth(c);
  const link = await getOwnedLink(c, user.userId);
  const rows = await c.var.db
    .select()
    .from(accessLeads)
    .where(eq(accessLeads.linkId, link.id))
    .orderBy(desc(accessLeads.createdAt))
    .all();
  return c.json(rows.map((r) => ({ email: r.email, ip_address: r.ipAddress ?? null, created_at: isoUtc(r.createdAt) ?? "" })));
});

// ============================================================================
// Link tags (auth required)
// ============================================================================

type Tag = typeof linkTags.$inferSelect;
const tagJson = (t: Tag) => ({ id: t.id, name: t.name, color: t.color ?? null, created_at: isoUtc(t.createdAt) });

async function ownTag(c: Ctx, tagId: string | undefined, userId: string): Promise<Tag | undefined> {
  const id = normUuid(tagId);
  if (!id) return undefined;
  return c.var.db
    .select()
    .from(linkTags)
    .where(and(eq(linkTags.id, id), eq(linkTags.userId, userId)))
    .get();
}

router.get("/tags", async (c) => {
  const user = await requireAuth(c);
  const rows = await c.var.db.select().from(linkTags).where(eq(linkTags.userId, user.userId)).orderBy(asc(linkTags.name)).all();
  return c.json(rows.map(tagJson));
});

router.post("/tags", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, z.record(z.string(), z.unknown()));
  const rawName = "name" in data ? data.name : "";
  if (typeof rawName !== "string") httpError(500, "Internal server error");
  const name = (rawName as string).trim();
  if (!name) httpError(400, "Tag name is required");
  const color = data.color == null ? null : String(data.color);
  const tag = await c.var.db
    .insert(linkTags)
    .values({ id: crypto.randomUUID(), userId: user.userId, name, color, createdAt: nowIso() })
    .returning()
    .get();
  return c.json(tagJson(tag), 201);
});

router.delete("/tags/:tag_id", async (c) => {
  const user = await requireAuth(c);
  const tag = await ownTag(c, c.req.param("tag_id"), user.userId);
  if (!tag) httpError(404, "Tag not found");
  await c.var.db.delete(linkTags).where(eq(linkTags.id, tag!.id)).run();
  return c.body(null, 204);
});

router.post("/links/:link_id/tags/:tag_id", async (c) => {
  const user = await requireAuth(c);
  const link = await getUserLink(c, c.req.param("link_id"), user.userId);
  const tag = await ownTag(c, c.req.param("tag_id"), user.userId);
  if (!tag) httpError(404, "Tag not found");
  const db = c.var.db;
  const where = and(eq(linkTagAssociations.linkId, link.id as string), eq(linkTagAssociations.tagId, tag!.id));
  if (await db.select().from(linkTagAssociations).where(where).get()) return c.json({ status: "already_tagged" }, 201);
  await db.insert(linkTagAssociations).values({ linkId: link.id as string, tagId: tag!.id }).run();
  return c.json({ status: "tagged" }, 201);
});

router.delete("/links/:link_id/tags/:tag_id", async (c) => {
  const user = await requireAuth(c);
  const link = await getUserLink(c, c.req.param("link_id"), user.userId);
  const tagId = normUuid(c.req.param("tag_id"));
  const db = c.var.db;
  const where = tagId ? and(eq(linkTagAssociations.linkId, link.id as string), eq(linkTagAssociations.tagId, tagId)) : null;
  if (!where || !(await db.select().from(linkTagAssociations).where(where).get())) {
    httpError(404, "Tag not associated with this link");
  }
  await db.delete(linkTagAssociations).where(where!).run();
  return c.body(null, 204);
});

// ============================================================================
// Analytics (/analytics/*)
// ============================================================================

registerAnalytics(router);
