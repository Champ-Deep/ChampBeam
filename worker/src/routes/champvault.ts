/**
 * Port of backend/app/api/v1/champvault.py — mounted at /api/v1/champvault.
 *
 * ChampVault content-hub endpoints. BD-facing: browse the external ChampVault
 * library and "beam" an asset — which mints a tracked ChampBeam short link
 * wrapping a fresh delivery URL. ChampBeam stores only the link + telemetry,
 * never the bytes. The link is recorded with the asset id so the redirect
 * handler re-mints a fresh delivery URL on each open (perpetual beams;
 * delivery URLs themselves expire).
 *
 * Distinct from /content — that is the org's *internal* shared library. This
 * is the external asset hub.
 */
import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { type TokenData, requireAuth } from "../auth/security";
import { chunk, type Db } from "../db/client";
import { champvaultFavorites, linkClicks } from "../db/schema";
import { HTTPError, httpError } from "../lib/errors";
import { nowIso } from "../lib/time";
import { parseJson, parseQuery } from "../lib/validate";
import {
  buildShareUrl,
  getChampvaultContent,
  getOrCreateChampvaultContent,
  mintShare,
  platformHost,
  resolveMemberDomain,
} from "../services/content";
import { recordLink } from "../services/utm";
import {
  type Asset,
  ChampVault,
  ChampVaultError,
  ChampVaultNotConfigured,
  assetToDict,
  deliveryTarget,
} from "./_champvault";
import { NOT_PROVISIONED } from "./_org";
import { resolveOrgUuid } from "../services/org";

export const router = new Hono<AppEnv>({ strict: false });

const BeamRequest = z.object({
  expires_in_days: z.number().int().min(1).max(30).default(7),
  domain_id: z.string().nullish(),
});

const client = (c: Ctx) => new ChampVault(c.var.settings);

function unavailable(err: unknown): HTTPError {
  if (err instanceof ChampVaultNotConfigured) return new HTTPError(503, err.message);
  if (err instanceof ChampVaultError) return new HTTPError(502, `ChampVault error: ${err.message}`);
  throw err;
}

/** Whether this deployment is wired to a ChampVault hub (for UI gating). */
router.get("/config", async (c) => {
  await requireAuth(c);
  const s = c.var.settings;
  // Computed live (Python's settings.champvault_configured is a property).
  return c.json({ configured: !!(s.champvaultUrl && s.champvaultApiKey) });
});

/** Which of `assetIds` the user has favorited (empty set if none given). */
async function favoriteIds(db: Db, userId: string, assetIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunk([...new Set(assetIds)])) {
    const rows = await db
      .select({ aid: champvaultFavorites.champvaultAssetId })
      .from(champvaultFavorites)
      .where(and(eq(champvaultFavorites.userId, userId), inArray(champvaultFavorites.champvaultAssetId, ids)))
      .all();
    for (const r of rows) out.add(r.aid);
  }
  return out;
}

/**
 * List published ChampVault assets (BD-facing -> published only).
 *
 * Each asset is annotated with `favorited` for the caller so the library can
 * render the star state without a second round-trip.
 */
router.get("/assets", async (c) => {
  const user = await requireAuth(c);
  const q = parseQuery(
    c,
    z.object({
      type: z.string().optional(),
      tag: z.string().optional(),
      q: z.string().optional(),
      collection: z.string().optional(),
    }),
  );
  let assets: Asset[];
  try {
    assets = await client(c).listAssets({ ...q, status: "published" });
  } catch (err) {
    throw unavailable(err);
  }
  const fav = await favoriteIds(
    c.var.db,
    user.userId,
    assets.map((a) => a.id),
  );
  return c.json(assets.map((a) => ({ ...assetToDict(a), favorited: fav.has(a.id) })));
});

/**
 * The caller's favorited assets (newest first) resolved to full details.
 *
 * This is the My Favorites shelf — it works regardless of the current search.
 * Assets that no longer resolve (deleted/unpublished on the ChampVault side)
 * are skipped so a stale favorite never breaks the shelf; an unconfigured hub
 * returns 503 like the rest of the ChampVault endpoints.
 */
router.get("/favorites", async (c) => {
  const user = await requireAuth(c);
  const rows = await c.var.db
    .select({ aid: champvaultFavorites.champvaultAssetId })
    .from(champvaultFavorites)
    .where(eq(champvaultFavorites.userId, user.userId))
    .orderBy(desc(champvaultFavorites.createdAt))
    .all();
  if (!rows.length) return c.json([]);

  const cv = client(c);
  let resolved: (Asset | null)[];
  try {
    resolved = await Promise.all(
      rows.map(async ({ aid }) => {
        // ChampVaultNotConfigured propagates (whole hub is down/misconfigured);
        // a per-asset ChampVaultError just drops that one favorite.
        try {
          return await cv.getAsset(aid);
        } catch (err) {
          if (err instanceof ChampVaultError) return null;
          throw err;
        }
      }),
    );
  } catch (err) {
    throw unavailable(err);
  }
  return c.json(resolved.filter((a): a is Asset => a !== null).map((a) => ({ ...assetToDict(a), favorited: true })));
});

/** Favorite an asset (idempotent — favoriting twice is a no-op). */
router.put("/assets/:asset_id/favorite", async (c) => {
  const user = await requireAuth(c);
  const assetId = c.req.param("asset_id");
  const db = c.var.db;
  const exists = await db
    .select({ id: champvaultFavorites.id })
    .from(champvaultFavorites)
    .where(and(eq(champvaultFavorites.userId, user.userId), eq(champvaultFavorites.champvaultAssetId, assetId)))
    .get();
  if (!exists) {
    await db
      .insert(champvaultFavorites)
      .values({ id: crypto.randomUUID(), userId: user.userId, champvaultAssetId: assetId, createdAt: nowIso() });
  }
  return c.body(null, 204);
});

/** Un-favorite an asset (idempotent). */
router.delete("/assets/:asset_id/favorite", async (c) => {
  const user = await requireAuth(c);
  await c.var.db
    .delete(champvaultFavorites)
    .where(
      and(eq(champvaultFavorites.userId, user.userId), eq(champvaultFavorites.champvaultAssetId, c.req.param("asset_id"))),
    );
  return c.body(null, 204);
});

router.get("/collections", async (c) => {
  await requireAuth(c);
  try {
    return c.json(await client(c).listCollections());
  } catch (err) {
    throw unavailable(err);
  }
});

router.get("/assets/:asset_id", async (c) => {
  await requireAuth(c);
  try {
    return c.json(assetToDict(await client(c).getAsset(c.req.param("asset_id"))));
  } catch (err) {
    throw unavailable(err);
  }
});

/**
 * Mint a tracked ChampBeam short link that wraps a ChampVault delivery URL.
 *
 * The link is owned by the caller (optionally on their own active domain) and
 * stamped with the asset id, so opens are tracked here and the destination is
 * re-minted fresh on each open (the delivery URL itself is short-lived).
 */
router.post("/assets/:asset_id/beam", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, BeamRequest);
  const assetId = c.req.param("asset_id");
  const db = c.var.db;
  const settings = c.var.settings;
  const cv = client(c);

  let delivered: Record<string, any>;
  try {
    delivered = await cv.deliver(assetId, data.expires_in_days * 86400);
  } catch (err) {
    throw unavailable(err);
  }

  const target = deliveryTarget(delivered);
  if (!target) httpError(502, "ChampVault returned no delivery URL.");

  // Org members: route the send through a shadow Content + ContentShare so it
  // rolls up in the org's team analytics like any other library sendout.
  // Signed-in-without-an-org (personal) users get a plain tracked beam (below).
  if (user.orgId) {
    return c.json(await beamForOrg(c, cv, user, assetId, target, delivered, data.domain_id ?? null), 201);
  }

  // Resolve the caller's chosen active domain (or platform default).
  const domain = await resolveMemberDomain(db, user.userId, data.domain_id);
  const hostname = domain ? domain.hostname : platformHost(settings);

  // One stable beam per (user, asset, domain): champvault://<id> is the dedup
  // key. Don't inject UTM into the signed delivery URL — tracking is via /r/.
  const link = await recordLink(db, {
    userId: user.userId,
    originalUrl: `champvault://${assetId}`,
    trackedUrl: target,
    utmParams: {},
    domainId: domain ? domain.id : null,
  });
  // Refresh the fallback URL and stamp the asset id.
  await db.update(linkClicks).set({ champvaultAssetId: assetId, trackedUrl: target }).where(eq(linkClicks.id, link.id));
  link.champvaultAssetId = assetId;
  link.trackedUrl = target;

  return c.json(
    {
      asset_id: assetId,
      link_id: link.id,
      beam_url: buildShareUrl(settings, { link, hostname }),
      kind: delivered.kind ?? null,
      expires_at: delivered.expiresAt ?? null,
    },
    201,
  );
});

/**
 * Org-scoped beam: upsert the org's shadow Content for the asset, then mint the
 * member's tracked share of it (idempotent per member+domain).
 */
async function beamForOrg(
  c: Ctx,
  cv: ChampVault,
  user: TokenData,
  assetId: string,
  target: string,
  delivered: Record<string, any>,
  domainId: string | null,
) {
  const db = c.var.db;
  const orgUuid = await resolveOrgUuid(db, user.orgId!);
  if (!orgUuid) httpError(409, NOT_PROVISIONED);

  let content = await getChampvaultContent(db, orgUuid, assetId);
  if (!content) {
    // First send of this asset in the org: fetch its details for a human title.
    let asset: Asset;
    try {
      asset = await cv.getAsset(assetId);
    } catch (err) {
      throw unavailable(err);
    }
    content = await getOrCreateChampvaultContent(db, orgUuid, assetId, {
      title: asset.title,
      description: asset.description,
      createdByUserId: user.userId,
    });
  }

  const { share, shareUrl } = await mintShare(db, c.var.settings, content, user.userId, domainId, {
    champvaultDeliveryUrl: target,
  });
  return {
    asset_id: assetId,
    content_id: content.id,
    link_id: share.linkId || null,
    beam_url: shareUrl,
    kind: delivered.kind ?? null,
    expires_at: delivered.expiresAt ?? null,
  };
}
