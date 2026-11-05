/** Service-level tests for src/services/pageState.ts and src/services/assetLookup.ts. */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { getSettings } from "../src/env";
import { domains, fileAssets, pageComments, pageState } from "../src/db/schema";
import { HTTPError } from "../src/lib/errors";
import { lookupAsset, resolveDomain, resolveHost } from "../src/services/assetLookup";
import * as ps from "../src/services/pageState";
import { createUser, env } from "./helpers";

const db = getDb(env.DB);
const settings = getSettings(env as never);

async function expectHttp(fn: () => unknown, status: number, detail?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HTTPError);
    expect((e as HTTPError).status).toBe(status);
    if (detail !== undefined) expect((e as HTTPError).detail).toBe(detail);
    return;
  }
  throw new Error("expected HTTPError");
}

async function insertAsset(userId: string, over: Partial<typeof fileAssets.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const rows = await db
    .insert(fileAssets)
    .values({
      id,
      userId,
      shortCode: `c${id.slice(0, 6)}`,
      filename: "page.html",
      kind: "html",
      mimeType: "text/html",
      storageKey: `k/${id}`,
      status: "active",
      ...over,
    })
    .returning();
  return rows[0];
}

async function insertDomain(userId: string, hostname: string, status = "active") {
  const rows = await db.insert(domains).values({ id: crypto.randomUUID(), userId, hostname, status }).returning();
  return rows[0];
}

describe("assetLookup", () => {
  it("platform host looks in the NULL-domain bucket by code or slug, active only", async () => {
    const user = await createUser();
    const a = await insertAsset(user.id, { shortCode: "AbC123", slug: "hello-page" });
    await insertAsset(user.id, { shortCode: "Dead01", status: "deleted" });
    expect((await lookupAsset(db, null, { shortCode: "AbC123" }))?.id).toBe(a.id);
    expect((await lookupAsset(db, null, { slug: "hello-page" }))?.id).toBe(a.id);
    expect(await lookupAsset(db, null, { shortCode: "Dead01" })).toBeNull();
    await expect(lookupAsset(db, null, {} as never)).rejects.toThrow();
  });

  it("custom domain: owner's platform assets fall back, exact domain wins, other users excluded", async () => {
    const owner = await createUser();
    const other = await createUser();
    const dom = await insertDomain(owner.id, "go.owner.test");
    const platform = await insertAsset(owner.id, { shortCode: "same01" });
    const exact = await insertAsset(owner.id, { shortCode: "same01", domainId: dom.id });
    await insertAsset(other.id, { shortCode: "theirs" });
    expect((await lookupAsset(db, dom, { shortCode: "same01" }))?.id).toBe(exact.id);
    await db.delete(fileAssets).where(eq(fileAssets.id, exact.id));
    expect((await lookupAsset(db, dom, { shortCode: "same01" }))?.id).toBe(platform.id);
    expect(await lookupAsset(db, dom, { shortCode: "theirs" })).toBeNull();
  });

  it("resolveDomain / resolveHost: platform, active custom, unknown/inactive custom", async () => {
    const owner = await createUser();
    await insertDomain(owner.id, "active.test");
    await insertDomain(owner.id, "pending.test", "pending_cname");
    expect(await resolveDomain(db, settings, "share.example.com")).toBeNull();
    expect((await resolveDomain(db, settings, "active.test"))?.hostname).toBe("active.test");
    expect((await resolveHost({ db, settings, host: "share.example.com" })).unknownHost).toBe(false);
    expect((await resolveHost({ db, settings, host: "active.test" })).unknownHost).toBe(false);
    expect((await resolveHost({ db, settings, host: "pending.test" })).unknownHost).toBe(true);
    expect((await resolveHost({ db, settings, host: "" })).unknownHost).toBe(false);
  });
});

describe("resolvePublicPage", () => {
  it("slug (case-insensitive) then short code (case-sensitive), html only, unknown host refused", async () => {
    const user = await createUser();
    const page = await insertAsset(user.id, { shortCode: "PgCode", slug: "state-page" });
    await insertAsset(user.id, { shortCode: "PdfOne", kind: "pdf", mimeType: "application/pdf" });
    const host = "share.example.com";
    expect((await ps.resolvePublicPageForHost(db, settings, host, " STATE-page "))?.id).toBe(page.id);
    expect((await ps.resolvePublicPageForHost(db, settings, host, "PgCode"))?.id).toBe(page.id);
    expect(await ps.resolvePublicPageForHost(db, settings, host, "pgcode")).toBeNull();
    expect(await ps.resolvePublicPageForHost(db, settings, host, "PdfOne")).toBeNull();
    expect(await ps.resolvePublicPageForHost(db, settings, "nobody.test", "state-page")).toBeNull();
  });
});

describe("lifecycle + token", () => {
  it("pageKilled", () => {
    const base = { revokedAt: null, expiresAt: null, maxViews: null, viewCount: 0 };
    expect(ps.pageKilled(base)).toBe(false);
    expect(ps.pageKilled({ ...base, revokedAt: new Date().toISOString() })).toBe(true);
    expect(ps.pageKilled({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(ps.pageKilled({ ...base, expiresAt: new Date(Date.now() + 60000).toISOString() })).toBe(false);
    expect(ps.pageKilled({ ...base, maxViews: 2, viewCount: 2 })).toBe(true);
    expect(ps.pageKilled({ ...base, maxViews: 2, viewCount: 1 })).toBe(false);
  });

  it("ensureStateToken mints once and persists; rotate replaces; checkToken", async () => {
    const user = await createUser();
    const asset = await insertAsset(user.id);
    const t1 = await ps.ensureStateToken(db, asset);
    expect(t1).toHaveLength(32);
    expect(await ps.ensureStateToken(db, asset)).toBe(t1);
    // a stale copy adopts the persisted token instead of overwriting it
    const stale = { ...asset, stateToken: null };
    expect(await ps.ensureStateToken(db, stale)).toBe(t1);

    ps.checkToken(asset, new Headers({ "X-Beam-Token": t1 }));
    ps.checkToken(asset, new Headers({ Authorization: `Bearer ${t1}` }));
    await expectHttp(() => ps.checkToken(asset, new Headers()), 401, "Invalid page token");
    await expectHttp(() => ps.checkToken(asset, new Headers({ "X-Beam-Token": "nope" })), 401);

    const t2 = await ps.rotateStateToken(db, asset);
    expect(t2).not.toBe(t1);
    const row = (await db.select().from(fileAssets).where(eq(fileAssets.id, asset.id)))[0];
    expect(row.stateToken).toBe(t2);
    await expectHttp(() => ps.checkToken(asset, new Headers({ "X-Beam-Token": t1 })), 401);
    await expectHttp(() => ps.checkToken({ stateToken: null }, new Headers({ "X-Beam-Token": "" })), 401);
  });
});

describe("validation + limits", () => {
  it("validateKey / validateValue / validateComment", async () => {
    expect(ps.validateKey("votes:a.b-c_1")).toBe("votes:a.b-c_1");
    await expectHttp(() => ps.validateKey("bad key"), 400);
    await expectHttp(() => ps.validateKey("x".repeat(121)), 400);
    expect(ps.validateValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
    await expectHttp(() => ps.validateValue(undefined), 400, "Value must be JSON-serializable.");
    await expectHttp(() => ps.validateValue("x".repeat(17 * 1024)), 413, "Value exceeds 16 KB.");
    // ensure_ascii: 3000 "é" are 6 bytes each in Python's encoding -> over 16 KB
    await expectHttp(() => ps.validateValue("é".repeat(3000)), 413);
    expect(ps.validateComment("  Ann ", " hi ")).toEqual(["Ann", "hi"]);
    await expectHttp(() => ps.validateComment("", "x"), 400, "Author is required (max 120 chars).");
    await expectHttp(() => ps.validateComment("a", "  "), 400, "Comment body is required.");
    await expectHttp(() => ps.validateComment("a", "x".repeat(4001)), 413, "Comment exceeds 4000 characters.");
  });

  it("enforceWriteLimit allows 30/minute per ip+page then 429s (test_caps_and_rate_limit)", async () => {
    const pageId = crypto.randomUUID();
    for (let i = 0; i < ps.WRITES_PER_MINUTE; i++) await ps.enforceWriteLimit(env.DB, "1.2.3.4", pageId);
    await expectHttp(() => ps.enforceWriteLimit(env.DB, "1.2.3.4", pageId), 429, "Too many writes (30/minute per page).");
    await ps.enforceWriteLimit(env.DB, "5.6.7.8", pageId); // other IP unaffected
  });

  it("counts and events", async () => {
    const user = await createUser();
    const asset = await insertAsset(user.id);
    expect(await ps.commentCount(db, asset.id)).toBe(0);
    await db.insert(pageComments).values([
      { pageId: asset.id, author: "a", body: "b" },
      { pageId: asset.id, author: "c", body: "d" },
    ]);
    await db.insert(pageState).values({ pageId: asset.id, key: "k", value: { x: 1 } });
    expect(await ps.commentCount(db, asset.id)).toBe(2);
    expect(await ps.keyCount(db, asset.id)).toBe(1);

    const ev = await ps.recordPageEvent(db, asset.id, "state_changed", { ref: "r".repeat(200), visitorId: "", ip: "1.1.1.1" });
    expect(ev.ref).toHaveLength(160);
    expect(ev.visitorId).toBeNull();
    expect(ev.ip).toBe("1.1.1.1");
    const [, evs] = await db.batch([
      db.insert(pageComments).values({ pageId: asset.id, author: "e", body: "f" }),
      ps.pageEventInsert(db, asset.id, "comment_added", { ref: "x" }),
    ]);
    expect(evs[0].eventType).toBe("comment_added");
  });
});
