/**
 * Briefing-room orchestration: slugs, tokenized recipient links, event
 * ingestion, and engagement scoring. Port of backend/app/services/room_service.py.
 *
 * Assets are referenced by ChampVault id (the MVP asset source). The room
 * render layer resolves those ids to signed delivery URLs at view time; this
 * service is purely the room/recipient/link/event spine + the self-ranking score.
 *
 * Exports:
 *   EVENT_* constants, EVENT_TYPES, DEFAULT_SCORE_WEIGHTS, VIDEO_THRESHOLD,
 *   DECK_THRESHOLD, DWELL_THRESHOLD_S
 *   roomUrl(settings, slug, token?, { hostname? }): string
 *   createRoom(db, { orgUuid, ownerUserId, title, bucket, assetIds, personalization }): Promise<Room>
 *   getOrgRoom(db, roomId, orgUuid): Promise<Room>                    (400 / 404)
 *   publishRoom(db, room): Promise<Room>                              (409; persists, mutates room)
 *   addRecipient(db, room, { ownerUserId, name, company, email, bucket }): Promise<[RoomRecipient, RoomLink]>
 *   mintLink(db, { roomId, recipientId }): Promise<RoomLink>          (503)
 *   resolveToken(db, token): Promise<[RoomLink, RoomRecipient | null]> (404)
 *   getPublicRoom(db, slug): Promise<Room>                            (404)
 *   renderPersonalization(room, recipient): Record<string, string>
 *   recordEvent(db, { room, link, eventType, payload, sessionId, country?, city? }): Promise<RoomEvent>
 *   computeScore(events, weights?): number
 *   types Room, RoomRecipient, RoomLink, RoomEvent
 */
import { and, eq } from "drizzle-orm";
import type { Settings } from "../env";
import type { Db } from "../db/client";
import { ROOM_ARCHIVED, ROOM_DRAFT, ROOM_PUBLISHED, roomEvents, roomLinks, roomRecipients, rooms } from "../db/schema";
import { randomString, tokenUrlsafe } from "../lib/crypto";
import { httpError } from "../lib/errors";
import { nowIso } from "../lib/time";

export type Room = typeof rooms.$inferSelect;
export type RoomRecipient = typeof roomRecipients.$inferSelect;
export type RoomLink = typeof roomLinks.$inferSelect;
export type RoomEvent = typeof roomEvents.$inferSelect;

// Event taxonomy (spec C2). Plain strings so new event kinds don't need a
// migration; the score weighting decides which ones count.
export const EVENT_PAGE_VIEW = "page_view";
export const EVENT_SESSION = "session";
export const EVENT_SCROLL_DEPTH = "scroll_depth";
export const EVENT_VIDEO_PROGRESS = "video_progress";
export const EVENT_DOC_VIEW = "doc_view";
export const EVENT_DOWNLOAD = "download";
export const EVENT_CTA_CLICK = "cta_click";
export const EVENT_RETURN_VISIT = "return_visit";
export const EVENT_TYPES = [
  EVENT_PAGE_VIEW,
  EVENT_SESSION,
  EVENT_SCROLL_DEPTH,
  EVENT_VIDEO_PROGRESS,
  EVENT_DOC_VIEW,
  EVENT_DOWNLOAD,
  EVENT_CTA_CLICK,
  EVENT_RETURN_VISIT,
] as const;

/** Default engagement weights (spec C3). Overridable per campaign. */
export const DEFAULT_SCORE_WEIGHTS: Readonly<Record<string, number>> = {
  video: 30, // a video watched to >= VIDEO_THRESHOLD %
  deck: 20, // a deck viewed to >= DECK_THRESHOLD %
  return_visit: 20,
  cta: 20,
  dwell: 10, // total session dwell > DWELL_THRESHOLD_S
};
export const VIDEO_THRESHOLD = 75;
export const DECK_THRESHOLD = 50;
export const DWELL_THRESHOLD_S = 180;

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function slugify(title: string): string {
  const base = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.slice(0, 60) || "room";
}

const rand = (n = 6) => randomString(n, SLUG_ALPHABET);

function schemeFor(host: string): string {
  return host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
}

export function roomUrl(
  settings: Pick<Settings, "resolvedPlatformRedirectHost">,
  slug: string,
  token?: string | null,
  opts: { hostname?: string | null } = {},
): string {
  const host = opts.hostname || settings.resolvedPlatformRedirectHost || "localhost:8000";
  const url = `${schemeFor(host)}://${host}/rooms/${slug}`;
  return token ? `${url}?t=${token}` : url;
}

/** Python `UUID(str)` acceptance (hyphens optional, braces/urn prefix, any case) -> canonical form. */
function parseUuid(v: string): string | null {
  const hex = v
    .trim()
    .replace(/^urn:uuid:/i, "")
    .replace(/^\{(.*)\}$/, "$1")
    .replace(/-/g, "")
    .toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A globally-unique slug derived from the title (with a random suffix on
 * collision, so two 'Ferrovial Briefing' rooms don't clash).
 */
async function uniqueSlug(db: Db, title: string): Promise<string> {
  const base = slugify(title);
  for (const candidate of [base, ...Array.from({ length: 8 }, () => `${base}-${rand()}`)]) {
    const hit = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.slug, candidate)).limit(1);
    if (!hit.length) return candidate;
  }
  return httpError(503, "Could not allocate a unique room slug.");
}

export async function createRoom(
  db: Db,
  opts: {
    orgUuid: string;
    ownerUserId: string | null | undefined;
    title: string;
    bucket: string | null | undefined;
    assetIds: string[] | null | undefined;
    personalization: Record<string, unknown> | null | undefined;
  },
): Promise<Room> {
  const now = nowIso();
  const rows = await db
    .insert(rooms)
    .values({
      id: crypto.randomUUID(),
      organizationId: opts.orgUuid,
      ownerUserId: opts.ownerUserId ? (parseUuid(opts.ownerUserId) ?? opts.ownerUserId) : null,
      title: opts.title,
      slug: await uniqueSlug(db, opts.title),
      bucket: opts.bucket ?? null,
      state: ROOM_DRAFT,
      assetIds: [...(opts.assetIds ?? [])],
      personalization: { ...(opts.personalization ?? {}) },
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0];
}

export async function getOrgRoom(db: Db, roomId: string, orgUuid: string): Promise<Room> {
  const rid = parseUuid(roomId);
  if (!rid) return httpError(400, "Invalid room id.");
  const rows = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.id, rid), eq(rooms.organizationId, orgUuid)))
    .limit(1);
  return rows[0] ?? httpError(404, "Room not found.");
}

export async function publishRoom(db: Db, room: Room): Promise<Room> {
  if (room.state === ROOM_ARCHIVED) httpError(409, "Archived rooms cannot be published.");
  const publishedAt = room.publishedAt ?? nowIso();
  const updatedAt = nowIso();
  await db.update(rooms).set({ state: ROOM_PUBLISHED, publishedAt, updatedAt }).where(eq(rooms.id, room.id));
  room.state = ROOM_PUBLISHED;
  room.publishedAt = publishedAt;
  room.updatedAt = updatedAt;
  return room;
}

async function newLinkToken(db: Db): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const token = tokenUrlsafe(16);
    const clash = await db.select({ id: roomLinks.id }).from(roomLinks).where(eq(roomLinks.token, token)).limit(1);
    if (!clash.length) return token;
  }
  return httpError(503, "Could not allocate a unique link token.");
}

function linkValues(roomId: string, recipientId: string | null, token: string) {
  return { id: crypto.randomUUID(), roomId, recipientId, token, createdAt: nowIso() };
}

/** Mint a unique tokenized link for a room (recipient optional). */
export async function mintLink(db: Db, opts: { roomId: string; recipientId: string | null }): Promise<RoomLink> {
  const token = await newLinkToken(db);
  const rows = await db.insert(roomLinks).values(linkValues(opts.roomId, opts.recipientId, token)).returning();
  return rows[0];
}

/** Create a recipient and mint their unique tokenized link (one atomic batch). */
export async function addRecipient(
  db: Db,
  room: Room,
  opts: {
    ownerUserId: string | null | undefined;
    name: string | null | undefined;
    company: string | null | undefined;
    email: string | null | undefined;
    bucket: string | null | undefined;
  },
): Promise<[RoomRecipient, RoomLink]> {
  const recipientId = crypto.randomUUID();
  const token = await newLinkToken(db);
  const [recipients, links] = await db.batch([
    db
      .insert(roomRecipients)
      .values({
        id: recipientId,
        roomId: room.id,
        organizationId: room.organizationId,
        ownerUserId: opts.ownerUserId ? (parseUuid(opts.ownerUserId) ?? opts.ownerUserId) : null,
        name: opts.name ?? null,
        company: opts.company ?? null,
        email: opts.email ?? null,
        bucket: opts.bucket || room.bucket,
        createdAt: nowIso(),
      })
      .returning(),
    db.insert(roomLinks).values(linkValues(room.id, recipientId, token)).returning(),
  ]);
  return [recipients[0], links[0]];
}

export async function resolveToken(db: Db, token: string): Promise<[RoomLink, RoomRecipient | null]> {
  const links = await db.select().from(roomLinks).where(eq(roomLinks.token, token)).limit(1);
  const link = links[0] ?? httpError(404, "Unknown link token.");
  let recipient: RoomRecipient | null = null;
  if (link.recipientId) {
    const rows = await db.select().from(roomRecipients).where(eq(roomRecipients.id, link.recipientId)).limit(1);
    recipient = rows[0] ?? null;
  }
  return [link, recipient];
}

export async function getPublicRoom(db: Db, slug: string): Promise<Room> {
  const rows = await db.select().from(rooms).where(eq(rooms.slug, slug)).limit(1);
  return rows[0] ?? httpError(404, "Room not found.");
}

/** Python str() for the scalar values a personalization context can hold. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/**
 * Resolve {{tokens}} in the room's personalization strings for a recipient.
 * Unknown recipients (forwarded/anonymous) get neutral fallbacks so the page
 * still renders cleanly ("Prepared for your team").
 */
export function renderPersonalization(
  room: Pick<Room, "personalization">,
  recipient: Pick<RoomRecipient, "company" | "name"> | null,
): Record<string, string> {
  const personalization = (room.personalization ?? {}) as Record<string, unknown>;
  const ctx: Record<string, unknown> = {
    company_name: recipient?.company ? recipient.company : "your team",
    contact_first_name: recipient?.name ? recipient.name.split(" ")[0] : "there",
    language: "language" in personalization ? personalization.language : "en",
  };
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(personalization)) {
    if (typeof template !== "string") continue;
    let rendered = template;
    for (const [tok, val] of Object.entries(ctx)) rendered = rendered.split(`{{${tok}}}`).join(pyStr(val));
    out[key] = rendered;
  }
  // Always expose the raw context too, so the render layer can compose its own.
  if (!("prepared_for_line" in out)) out.prepared_for_line = `Prepared for ${pyStr(ctx.company_name)}`;
  return out;
}

export async function recordEvent(
  db: Db,
  opts: {
    room: Pick<Room, "id">;
    link: Pick<RoomLink, "id" | "recipientId"> | null;
    eventType: string;
    payload: Record<string, unknown> | null | undefined;
    sessionId: string | null | undefined;
    country?: string | null;
    city?: string | null;
  },
): Promise<RoomEvent> {
  const rows = await db
    .insert(roomEvents)
    .values({
      id: crypto.randomUUID(),
      roomId: opts.room.id,
      linkId: opts.link ? opts.link.id : null,
      recipientId: opts.link ? opts.link.recipientId : null,
      sessionId: opts.sessionId ?? null,
      type: opts.eventType,
      payload: { ...(opts.payload ?? {}) },
      country: opts.country ?? null,
      city: opts.city ?? null,
      createdAt: nowIso(),
    })
    .returning();
  return rows[0];
}

const isDict = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** float(x or 0) that degrades to 0 on garbage (Python raised there). */
function num(v: unknown): number {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function percent(payload: unknown): number {
  return isDict(payload) ? num(payload.percent) : 0;
}

type ScoredEvent = Pick<RoomEvent, "type" | "payload" | "sessionId">;

/** Collapse a recipient's events into a single 0–100 engagement score. */
export function computeScore(events: Iterable<ScoredEvent>, weights?: Record<string, number> | null): number {
  const w = { ...DEFAULT_SCORE_WEIGHTS, ...(weights ?? {}) };
  const list = [...events];

  const gotVideo = list.some((e) => e.type === EVENT_VIDEO_PROGRESS && percent(e.payload) >= VIDEO_THRESHOLD);
  const gotDeck = list.some((e) => e.type === EVENT_DOC_VIEW && percent(e.payload) >= DECK_THRESHOLD);
  const sessions = new Set(list.map((e) => e.sessionId).filter(Boolean));
  const gotReturn = sessions.size > 1 || list.some((e) => e.type === EVENT_RETURN_VISIT);
  const gotCta = list.some((e) => e.type === EVENT_CTA_CLICK);
  const totalDwell = list
    .filter((e) => e.type === EVENT_SESSION && isDict(e.payload))
    .reduce((acc, e) => acc + num((e.payload as Record<string, unknown>).duration_s), 0);
  const gotDwell = totalDwell > DWELL_THRESHOLD_S;

  const score =
    (gotVideo ? w.video : 0) +
    (gotDeck ? w.deck : 0) +
    (gotReturn ? w.return_visit : 0) +
    (gotCta ? w.cta : 0) +
    (gotDwell ? w.dwell : 0);
  return Math.max(0, Math.min(100, Math.trunc(score)));
}
