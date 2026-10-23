/**
 * Port of backend/app/api/v1/rooms.py — mounted at /api/v1/rooms.
 *
 * Hosted Briefing Rooms + identified visit tracking (functional spec Modules B & C).
 *
 * Authenticated, org-scoped endpoints let a BD rep assemble a room from
 * ChampVault assets, add recipients (each minted a unique tokenized link), and
 * read a self-ranking engagement dashboard. Two **public** endpoints (no auth)
 * back the hosted page: resolve a room+token for rendering, and ingest
 * engagement events.
 */
import { Hono } from "hono";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireOrgMember } from "../auth/security";
import type { Db } from "../db/client";
import { ROOM_ARCHIVED, ROOM_PUBLISHED, roomEvents, roomLinks, roomRecipients, rooms } from "../db/schema";
import { clientIp } from "../lib/accessControl";
import { httpError } from "../lib/errors";
import { cfGeo } from "../lib/request";
import { isoUtc, nowIso } from "../lib/time";
import { parseJson, parseQuery } from "../lib/validate";
import { lookupIp } from "../services/geoip";
import {
  EVENT_TYPES,
  type Room,
  type RoomLink,
  type RoomRecipient,
  addRecipient,
  computeScore,
  createRoom,
  getOrgRoom,
  getPublicRoom,
  publishRoom,
  recordEvent,
  renderPersonalization,
  roomUrl,
} from "../services/room";
import { orgUuidForUser } from "./_org";

export const router = new Hono<AppEnv>({ strict: false });

// ============================================================================
// Schemas
// ============================================================================

const Dict = z.record(z.string(), z.any());

const RoomCreate = z.object({
  title: z.string().min(1).max(255),
  bucket: z.string().max(80).nullish(),
  asset_ids: z.array(z.string()).default([]),
  personalization: Dict.default({}),
});

const RoomUpdate = z.object({
  title: z.string().max(255).nullish(),
  bucket: z.string().max(80).nullish(),
  asset_ids: z.array(z.string()).nullish(),
  personalization: Dict.nullish(),
});

const RecipientCreate = z.object({
  name: z.string().max(255).nullish(),
  company: z.string().max(255).nullish(),
  email: z.string().max(320).nullish(),
  bucket: z.string().max(80).nullish(),
});

const TrackRequest = z.object({
  slug: z.string(),
  type: z.string(),
  token: z.string().nullish(),
  session_id: z.string().max(64).nullish(),
  payload: Dict.default({}),
});

// ============================================================================
// Helpers
// ============================================================================

async function recipientCount(db: Db, roomId: string): Promise<number> {
  const row = await db
    .select({ n: count(roomRecipients.id) })
    .from(roomRecipients)
    .where(eq(roomRecipients.roomId, roomId))
    .get();
  return Number(row?.n ?? 0);
}

function roomResponse(room: Room, recipients: number) {
  return {
    id: room.id,
    title: room.title,
    slug: room.slug,
    bucket: room.bucket,
    state: room.state,
    asset_ids: [...(room.assetIds ?? [])],
    personalization: { ...(room.personalization ?? {}) },
    recipient_count: recipients,
    created_at: isoUtc(room.createdAt) ?? "",
  };
}

async function linkByToken(db: Db, token: string): Promise<RoomLink | null> {
  return (await db.select().from(roomLinks).where(eq(roomLinks.token, token)).get()) ?? null;
}

// ============================================================================
// Authenticated (org-scoped) endpoints
// ============================================================================

router.post("/", async (c) => {
  const user = await requireOrgMember(c);
  const data = await parseJson(c, RoomCreate);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);
  const room = await createRoom(db, {
    orgUuid,
    ownerUserId: user.userId,
    title: data.title,
    bucket: data.bucket,
    assetIds: data.asset_ids,
    personalization: data.personalization,
  });
  return c.json(roomResponse(room, 0), 201);
});

router.get("/", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);
  const rows = await db.select().from(rooms).where(eq(rooms.organizationId, orgUuid)).orderBy(desc(rooms.createdAt)).all();
  const out = [];
  for (const r of rows) out.push(roomResponse(r, await recipientCount(db, r.id)));
  return c.json(out);
});

// ============================================================================
// Public endpoints (no auth) — back the hosted page.
// Registered before "/:room_id" for clarity (paths don't overlap anyway).
// ============================================================================

/**
 * Resolve a room (and optional recipient token) for the render layer.
 *
 * Draft rooms are treated as not-found publicly; archived rooms resolve with
 * `ended=true` so the page can show a branded "this briefing has ended"
 * message instead of a 404.
 */
router.get("/public/:slug", async (c) => {
  const { t } = parseQuery(c, z.object({ t: z.string().optional() }));
  const db = c.var.db;
  const room = await getPublicRoom(db, c.req.param("slug"));
  if (room.state !== ROOM_PUBLISHED && room.state !== ROOM_ARCHIVED) httpError(404, "Room not found.");

  let recipient: RoomRecipient | null = null;
  if (t) {
    const link = await linkByToken(db, t);
    if (link && link.roomId === room.id && link.recipientId) {
      recipient =
        (await db.select().from(roomRecipients).where(eq(roomRecipients.id, link.recipientId)).get()) ?? null;
    }
  }

  return c.json({
    slug: room.slug,
    title: room.title,
    state: room.state,
    ended: room.state === ROOM_ARCHIVED,
    asset_ids: [...(room.assetIds ?? [])],
    personalization: renderPersonalization(room, recipient),
    identified: recipient !== null,
  });
});

/**
 * Ingest an engagement event from a hosted room (public beacon).
 *
 * Attribution: a valid `token` identifies the recipient; without one the
 * event is recorded anonymously (forwarded/unknown viewer). Geo is stored at
 * city level only (GDPR data-minimization); full IP is never persisted.
 */
router.post("/track", async (c) => {
  const data = await parseJson(c, TrackRequest);
  if (!(EVENT_TYPES as readonly string[]).includes(data.type)) {
    httpError(400, `Unknown event type '${data.type}'.`);
  }
  const db = c.var.db;
  const room = await getPublicRoom(db, data.slug);

  let link: RoomLink | null = null;
  if (data.token) {
    link = await linkByToken(db, data.token);
    if (link && link.roomId !== room.id) link = null; // token belongs to a different room; treat as anonymous
  }

  let country: string | null = null;
  let city: string | null = null;
  const ip = clientIp(c);
  if (ip) {
    try {
      const geo = await lookupIp({ settings: c.var.settings, db }, ip, { cf: cfGeo(c) });
      if (geo) {
        country = geo.country;
        city = geo.city;
      }
    } catch (err) {
      // geo is best-effort, never blocks ingest
      console.debug("room track: geo lookup failed", err);
    }
  }

  await recordEvent(db, {
    room,
    link,
    eventType: data.type,
    payload: data.payload,
    sessionId: data.session_id,
    country,
    city,
  });
  return c.body(null, 204);
});

// ============================================================================
// Authenticated, per-room
// ============================================================================

router.get("/:room_id", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const room = await getOrgRoom(db, c.req.param("room_id"), await orgUuidForUser(db, user));
  return c.json(roomResponse(room, await recipientCount(db, room.id)));
});

router.patch("/:room_id", async (c) => {
  const user = await requireOrgMember(c);
  const data = await parseJson(c, RoomUpdate);
  const db = c.var.db;
  const room = await getOrgRoom(db, c.req.param("room_id"), await orgUuidForUser(db, user));
  const patch: Partial<Room> = {};
  if (data.title != null) patch.title = data.title;
  if (data.bucket != null) patch.bucket = data.bucket;
  if (data.asset_ids != null) patch.assetIds = [...data.asset_ids];
  if (data.personalization != null) patch.personalization = { ...data.personalization };
  if (Object.keys(patch).length) {
    patch.updatedAt = nowIso();
    await db.update(rooms).set(patch).where(eq(rooms.id, room.id));
    Object.assign(room, patch);
  }
  return c.json(roomResponse(room, await recipientCount(db, room.id)));
});

router.post("/:room_id/publish", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const room = await getOrgRoom(db, c.req.param("room_id"), await orgUuidForUser(db, user));
  await publishRoom(db, room);
  return c.json(roomResponse(room, await recipientCount(db, room.id)));
});

/**
 * Archive a room. Its links keep resolving, but the page shows a branded
 * "this briefing has ended" state instead of the content (never a 404).
 */
router.post("/:room_id/archive", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const room = await getOrgRoom(db, c.req.param("room_id"), await orgUuidForUser(db, user));
  const updatedAt = nowIso();
  await db.update(rooms).set({ state: ROOM_ARCHIVED, updatedAt }).where(eq(rooms.id, room.id));
  room.state = ROOM_ARCHIVED;
  room.updatedAt = updatedAt;
  return c.json(roomResponse(room, await recipientCount(db, room.id)));
});

router.post("/:room_id/recipients", async (c) => {
  const user = await requireOrgMember(c);
  const data = await parseJson(c, RecipientCreate);
  const db = c.var.db;
  const room = await getOrgRoom(db, c.req.param("room_id"), await orgUuidForUser(db, user));
  const [recipient, link] = await addRecipient(db, room, {
    ownerUserId: user.userId,
    name: data.name,
    company: data.company,
    email: data.email,
    bucket: data.bucket,
  });
  return c.json(
    {
      id: recipient.id,
      name: recipient.name,
      company: recipient.company,
      email: recipient.email,
      bucket: recipient.bucket,
      token: link.token,
      url: roomUrl(c.var.settings, room.slug, link.token),
    },
    201,
  );
});

/**
 * Per-recipient engagement scores (self-ranking follow-up list) + the
 * anonymous/forwarded-viewer signal.
 */
router.get("/:room_id/analytics", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const room = await getOrgRoom(db, c.req.param("room_id"), await orgUuidForUser(db, user));

  const recipients = await db.select().from(roomRecipients).where(eq(roomRecipients.roomId, room.id)).all();
  // All events of this room's recipients in one query, grouped in memory.
  const events = recipients.length
    ? await db
        .select()
        .from(roomEvents)
        .where(
          inArray(
            roomEvents.recipientId,
            db.select({ id: roomRecipients.id }).from(roomRecipients).where(eq(roomRecipients.roomId, room.id)),
          ),
        )
        .all()
    : [];
  const byRecipient = new Map<string, typeof events>();
  for (const e of events) {
    const list = byRecipient.get(e.recipientId!) ?? [];
    list.push(e);
    byRecipient.set(e.recipientId!, list);
  }

  const out = recipients.map((r, i) => {
    const evs = byRecipient.get(r.id) ?? [];
    const last = evs.reduce<string | null>((m, e) => (e.createdAt && (m === null || e.createdAt > m) ? e.createdAt : m), null);
    return {
      i,
      row: {
        recipient_id: r.id,
        name: r.name,
        company: r.company,
        email: r.email,
        score: computeScore(evs),
        events: evs.length,
        last_engaged_at: last ? isoUtc(last) : null,
      },
    };
  });
  // Self-ranking (stable, like Python's sort).
  out.sort((a, b) => b.row.score - a.row.score || a.i - b.i);

  const anon = await db
    .select({ sessionId: roomEvents.sessionId })
    .from(roomEvents)
    .where(and(eq(roomEvents.roomId, room.id), isNull(roomEvents.linkId)))
    .all();

  return c.json({
    room_id: room.id,
    title: room.title,
    recipients: out.map((o) => o.row),
    anonymous_events: anon.length,
    anonymous_sessions: new Set(anon.map((e) => e.sessionId).filter(Boolean)).size,
  });
});
