/**
 * Public Beam State API: per-page comments + key-value state for hosted pages.
 * Port of backend/app/api/page_state.py — mounted at /api/pages.
 *
 * Mounted at /api/pages (NOT under /api/v1) so it is same-origin with the
 * served page on every host — platform or BYOD — and satisfies the hosted-HTML
 * CSP's `connect-src 'self'`. Auth is the page-scoped public token the serve
 * path injects into the page (`window.__BEAM__.token`); it only ever addresses
 * its own page because every lookup is page-first.
 *
 * 410 on every route once the page is killed (revoked / expired / view cap).
 */
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { isUniqueViolation } from "../db/client";
import { PAGE_EVENT_COMMENT_ADDED, PAGE_EVENT_STATE_CHANGED, pageComments, pageState } from "../db/schema";
import { clientIp } from "../lib/accessControl";
import { httpError, HTTPError } from "../lib/errors";
import { getCookie } from "../lib/request";
import { isoUtc, nowIso } from "../lib/time";
import { parseJson, parseQuery, qInt, qStr } from "../lib/validate";
import type { FileAsset } from "../services/assetLookup";
import * as ps from "../services/pageState";
import { VISITOR_COOKIE, validVisitorId } from "../services/pages";

export const router = new Hono<AppEnv>({ strict: false });

const CommentIn = z.object({
  author: z.string().max(ps.MAX_AUTHOR),
  body: z.string().max(ps.MAX_COMMENT_BODY + 1),
});

type CommentRow = { id: string; author: string; body: string; createdAt: string | null };

const commentOut = (c: CommentRow) => ({ id: c.id, author: c.author, body: c.body, ts: isoUtc(c.createdAt) });

async function pageForWrite(c: Ctx, ident: string): Promise<FileAsset> {
  const asset = await ps.resolvePublicPage(c, ident);
  if (!asset) return httpError(404, "Page not found.");
  if (ps.pageKilled(asset)) httpError(410, "This page is no longer available.");
  ps.checkToken(asset, c.req.raw.headers);
  return asset;
}

// Reads need the token too: state can hold whatever the page put there.
const pageForRead = pageForWrite;

const visitor = (c: Ctx) => validVisitorId(getCookie(c, VISITOR_COOKIE));

/** JSON body of any shape (`Body(default=None)`): empty -> null, invalid -> 422. */
async function anyJsonBody(c: Ctx): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HTTPError(422, [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {} }]);
  }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

router.get("/:ident/comments", async (c) => {
  const q = parseQuery(c, z.object({ after: qStr(), limit: qInt(200, { ge: 1, le: 500 }) }));
  const asset = await pageForRead(c, c.req.param("ident"));
  const db = c.var.db;

  // Ordered by created_at, then insertion order (rowid) so comments landing in
  // the same millisecond keep a stable order and `after` never skips one.
  let anchor: { createdAt: string | null; rid: number } | undefined;
  if (q.after) {
    if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(q.after)) {
      httpError(400, "after must be a comment id.");
    }
    anchor = await db
      .select({ createdAt: pageComments.createdAt, rid: sql<number>`rowid` })
      .from(pageComments)
      .where(and(eq(pageComments.id, q.after.toLowerCase()), eq(pageComments.pageId, asset.id)))
      .get();
  }
  const rows = await db
    .select({ id: pageComments.id, author: pageComments.author, body: pageComments.body, createdAt: pageComments.createdAt })
    .from(pageComments)
    .where(
      and(
        eq(pageComments.pageId, asset.id),
        anchor
          ? sql`(${pageComments.createdAt} > ${anchor.createdAt} OR (${pageComments.createdAt} = ${anchor.createdAt} AND rowid > ${anchor.rid}))`
          : undefined,
      ),
    )
    .orderBy(pageComments.createdAt, sql`rowid`)
    .limit(q.limit ?? 200)
    .all();
  return c.json({
    comments: rows.map(commentOut),
    next_after: rows.length ? rows[rows.length - 1].id : (q.after ?? null),
  });
});

router.post("/:ident/comments", async (c) => {
  const data = await parseJson(c, CommentIn);
  const asset = await pageForWrite(c, c.req.param("ident"));
  const [author, body] = ps.validateComment(data.author, data.body);
  const ip = clientIp(c);
  await ps.enforceWriteLimit(c.env.DB, ip, asset.id);
  const db = c.var.db;
  if ((await ps.commentCount(db, asset.id)) >= ps.MAX_COMMENTS_PER_PAGE) {
    httpError(409, "This page has reached its comment limit.");
  }

  const v = visitor(c);
  const comment = { id: crypto.randomUUID(), pageId: asset.id, author, body, visitorId: v, ip, createdAt: nowIso() };
  await db.batch([
    db.insert(pageComments).values(comment),
    ps.pageEventInsert(db, asset.id, PAGE_EVENT_COMMENT_ADDED, { ref: comment.id, visitorId: v, ip }),
  ]);
  return c.json(commentOut(comment), 201);
});

// ---------------------------------------------------------------------------
// Key-value state
// ---------------------------------------------------------------------------

type StateRow = { key: string; value: unknown; updatedAt: string };

const stateOut = (s: StateRow) => ({ key: s.key, value: s.value, updated_at: isoUtc(s.updatedAt) });

router.get("/:ident/state", async (c) => {
  const asset = await pageForRead(c, c.req.param("ident"));
  const rows = await c.var.db
    .select({ key: pageState.key, value: pageState.value, updatedAt: pageState.updatedAt })
    .from(pageState)
    .where(eq(pageState.pageId, asset.id))
    .orderBy(pageState.key)
    .all();
  let latest: string | null = null;
  const state: Record<string, unknown> = {};
  for (const r of rows) {
    state[r.key] = r.value;
    if (latest === null || r.updatedAt > latest) latest = r.updatedAt;
  }
  return c.json({ state, updated_at: isoUtc(latest) });
});

router.get("/:ident/state/:key", async (c) => {
  const asset = await pageForRead(c, c.req.param("ident"));
  const row = await c.var.db
    .select({ key: pageState.key, value: pageState.value, updatedAt: pageState.updatedAt })
    .from(pageState)
    .where(and(eq(pageState.pageId, asset.id), eq(pageState.key, c.req.param("key"))))
    .get();
  if (!row) httpError(404, "Key not set.");
  return c.json(stateOut(row!));
});

/** Last-writer-wins JSON value for `key`. Any JSON value is accepted. */
router.put("/:ident/state/:key", async (c) => {
  const value = await anyJsonBody(c);
  const asset = await pageForWrite(c, c.req.param("ident"));
  const key = ps.validateKey(c.req.param("key"));
  ps.validateValue(value);
  const ip = clientIp(c);
  await ps.enforceWriteLimit(c.env.DB, ip, asset.id);
  const v = visitor(c);
  const db = c.var.db;
  const now = nowIso();
  const where = and(eq(pageState.pageId, asset.id), eq(pageState.key, key));
  const event = () => ps.pageEventInsert(db, asset.id, PAGE_EVENT_STATE_CHANGED, { ref: key, visitorId: v, ip });
  const update = () =>
    db.batch([db.update(pageState).set({ value, updatedAt: now, updatedByVisitor: v }).where(where), event()]);

  const existing = await db.select({ id: pageState.id }).from(pageState).where(where).get();
  if (!existing) {
    if ((await ps.keyCount(db, asset.id)) >= ps.MAX_KEYS_PER_PAGE) {
      httpError(409, "This page has reached its key limit.");
    }
    try {
      await db.batch([
        db.insert(pageState).values({ id: crypto.randomUUID(), pageId: asset.id, key, value, updatedAt: now, updatedByVisitor: v }),
        event(),
      ]);
    } catch (err) {
      // Lost a race with another writer creating the same key: fall back to update.
      if (!isUniqueViolation(err)) throw err;
      await update();
    }
  } else {
    await update();
  }
  return c.json(stateOut({ key, value, updatedAt: now }));
});

router.delete("/:ident/state/:key", async (c) => {
  const asset = await pageForWrite(c, c.req.param("ident"));
  const ip = clientIp(c);
  await ps.enforceWriteLimit(c.env.DB, ip, asset.id);
  const db = c.var.db;
  const key = c.req.param("key");
  const where = and(eq(pageState.pageId, asset.id), eq(pageState.key, key));
  const row = await db.select({ id: pageState.id }).from(pageState).where(where).get();
  if (row) {
    await db.batch([
      db.delete(pageState).where(eq(pageState.id, row.id)),
      ps.pageEventInsert(db, asset.id, PAGE_EVENT_STATE_CHANGED, { ref: key, visitorId: visitor(c), ip }),
    ]);
  }
  return new Response(null, { status: 204 });
});
