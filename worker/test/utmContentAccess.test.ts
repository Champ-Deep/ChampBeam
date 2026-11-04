/**
 * Service-level coverage for project.ts, content.ts, lib/accessControl.ts and
 * lib/accessPages.ts (the Python had no dedicated unit tests for these; their
 * route tests are ported with the routes).
 */
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { buildSettings, type Env } from "../src/env";
import * as ac from "../src/lib/accessControl";
import { blockedPage, codeGatePage, emailGatePage } from "../src/lib/accessPages";
import { HTTPError } from "../src/lib/errors";
import * as content from "../src/services/content";
import * as project from "../src/services/project";
import * as utm from "../src/services/utm";
import { createOrg, createUser } from "./helpers";

const db = () => getDb(env.DB);
const settings = buildSettings(env as unknown as Env);
const now = () => new Date().toISOString();

describe("project service", () => {
  it("CRUD + stats", async () => {
    const user = await createUser();
    const p = await project.createProject(db(), user.id, "Launch", null);
    await project.createProject(db(), user.id, "Second", "d");
    expect((await project.listProjects(db(), user.id)).map((x) => x.name)).toEqual(["Second", "Launch"]);
    expect(await project.getProject(db(), p.id, crypto.randomUUID())).toBeNull();

    const updated = await project.updateProject(db(), p, null, "desc");
    expect(updated.name).toBe("Launch");
    expect(updated.description).toBe("desc");

    const link = await utm.recordLink(db(), {
      userId: user.id, originalUrl: "https://a.com", trackedUrl: "https://a.com", utmParams: {}, projectId: p.id,
    });
    await env.DB.prepare("UPDATE link_clicks SET click_count = 7 WHERE id = ?").bind(link.id).run();
    expect(await project.getProjectStats(db(), p.id)).toEqual({ link_count: 1, total_clicks: 7 });

    await project.deleteProject(db(), p);
    expect(await project.getProject(db(), p.id, user.id)).toBeNull();
    const row = await env.DB.prepare("SELECT project_id FROM link_clicks WHERE id = ?").bind(link.id).first();
    expect(row).toEqual({ project_id: null });
  });
});

describe("content service", () => {
  async function seed(kind: "link" | "file", extra: Record<string, unknown> = {}) {
    const org = await createOrg();
    const member = await createUser();
    const contentId = crypto.randomUUID();
    let fileId: string | null = null;
    if (kind === "file") {
      fileId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO file_assets (id, user_id, short_code, filename, kind, mime_type, size_bytes, storage_key, status, serve_mode, view_count, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(fileId, member.id, content.shortCode(), "Pitch Deck (v2).pdf", "pdf", "application/pdf", 10, "files/k", "active", "stream", 5, now())
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO content_items (id, organization_id, title, kind, canonical_url, champvault_asset_id, file_id, is_archived, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?,?)`,
    )
      .bind(contentId, org.id, "T", kind, kind === "link" ? "https://acme.com/case" : null, extra.champvault ?? null, fileId, now(), now())
      .run();
    const item = (await content.getChampvaultContent(db(), org.id, "nope")) ?? null;
    expect(item).toBeNull();
    const row = await db().query.contentItems.findFirst({ where: (t, { eq }) => eq(t.id, contentId) });
    return { org, member, item: row!, fileId };
  }

  it("mintShare (link) is idempotent per member+domain and builds /r/ URLs", async () => {
    const { member, item } = await seed("link");
    const a = await content.mintShare(db(), settings, item, member.id);
    expect(a.shareUrl).toMatch(/^https:\/\/share\.example\.com\/r\/[A-Za-z0-9]{7}$/);
    const b = await content.mintShare(db(), settings, item, member.id);
    expect(b.share.id).toBe(a.share.id);
    expect(b.shareUrl).toBe(a.shareUrl);
  });

  it("mintShare (champvault link) stamps the asset and refreshes the delivery URL on re-send", async () => {
    const { member, item } = await seed("link", { champvault: "asset-1" });
    const a = await content.mintShare(db(), settings, item, member.id, null, { champvaultDeliveryUrl: "https://cv/d1" });
    const link1 = await env.DB.prepare("SELECT tracked_url, champvault_asset_id FROM link_clicks WHERE id = ?").bind(a.share.linkId).first();
    expect(link1).toEqual({ tracked_url: "https://cv/d1", champvault_asset_id: "asset-1" });
    await content.mintShare(db(), settings, item, member.id, null, { champvaultDeliveryUrl: "https://cv/d2" });
    const link2 = await env.DB.prepare("SELECT tracked_url FROM link_clicks WHERE id = ?").bind(a.share.linkId).first();
    expect(link2).toEqual({ tracked_url: "https://cv/d2" });
  });

  it("mintShare (file) copies the asset row sharing the bytes", async () => {
    const { member, item, fileId } = await seed("file");
    const { share, shareUrl } = await content.mintShare(db(), settings, item, member.id);
    expect(share.fileId).not.toBe(fileId);
    expect(shareUrl).toMatch(/^https:\/\/share\.example\.com\/f\/[A-Za-z0-9]{8}\/Pitch_Deck__v2_\.pdf$/);
    const copy = await env.DB.prepare("SELECT storage_key, view_count, status FROM file_assets WHERE id = ?").bind(share.fileId).first();
    expect(copy).toEqual({ storage_key: "files/k", view_count: 0, status: "active" });
  });

  it("bad domain ids are 400s with the Python details", async () => {
    const { member, item } = await seed("link");
    const err1 = await content.mintShare(db(), settings, item, member.id, "not-a-uuid").catch((e) => e);
    expect(err1).toBeInstanceOf(HTTPError);
    expect([err1.status, err1.detail]).toEqual([400, "Invalid domain_id."]);
    const err2 = await content.mintShare(db(), settings, item, member.id, crypto.randomUUID()).catch((e) => e);
    expect([err2.status, err2.detail]).toEqual([400, "Domain not found, not yours, or not active."]);
  });

  it("getOrCreateChampvaultContent is idempotent", async () => {
    const org = await createOrg();
    const a = await content.getOrCreateChampvaultContent(db(), org.id, "cv-9", { title: "", description: null, createdByUserId: null });
    expect(a.title).toBe("ChampVault asset cv-9");
    expect(a.canonicalUrl).toBe("champvault://cv-9");
    const b = await content.getOrCreateChampvaultContent(db(), org.id, "cv-9", { title: "X", description: null, createdByUserId: null });
    expect(b.id).toBe(a.id);
  });

  it("buildShareUrl uses http for localhost", () => {
    expect(content.buildShareUrl(settings, { link: { shortCode: "abc" }, hostname: "localhost:8000" })).toBe(
      "http://localhost:8000/r/abc",
    );
  });
});

describe("access control", () => {
  it("validEmail / cookie names", () => {
    expect(ac.validEmail(" a@b.co ")).toBe(true);
    expect(ac.validEmail("nope")).toBe(false);
    expect(ac.validEmail(null)).toBe(false);
    expect(ac.gateCookieName("ab-c_d!")).toBe("cbgate_abcd");
    expect(ac.codeCookieName("x.y")).toBe("cbcode_xy");
  });

  it("access codes: validate, hash, verify, cookie", async () => {
    const asset = { id: crypto.randomUUID(), accessCodeHash: null as string | null, shortCode: "pg1" };
    await expect(ac.setAccessCode(settings, asset, "12a4")).rejects.toMatchObject({ status: 422, detail: "Access code must be 4–8 digits." });
    const h = await ac.setAccessCode(settings, asset, " 4821 ");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await ac.verifyAccessCode(settings, asset, "4821")).toBe(true);
    expect(await ac.verifyAccessCode(settings, asset, "4822")).toBe(false);

    const app = new Hono().get("/", async (c) => c.json({ ok: await ac.hasCodeCookie(c, asset) }));
    const val = await ac.codeCookieValue(asset);
    expect(val).toHaveLength(32);
    const ok = await app.request("/", { headers: { Cookie: `cbcode_pg1=${val}` } });
    expect(await ok.json()).toEqual({ ok: true });
    const bad = await app.request("/", { headers: { Cookie: "cbcode_pg1=nope" } });
    expect(await bad.json()).toEqual({ ok: false });

    expect(await ac.setAccessCode(settings, asset, "")).toBeNull();
    expect(asset.accessCodeHash).toBeNull();
  });

  it("codeAttemptLimited trips after 5 attempts per IP/page", async () => {
    const page = crypto.randomUUID();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await ac.codeAttemptLimited(env.DB, "1.2.3.4", page));
    expect(results).toEqual([false, false, false, false, false, true]);
    expect(await ac.codeAttemptLimited(env.DB, "5.6.7.8", page)).toBe(false);
  });

  it("codeAttemptLimited fails closed when the counter store errors", async () => {
    const broken = { prepare: () => { throw new Error("D1_ERROR: down"); } } as unknown as D1Database;
    expect(await ac.codeAttemptLimited(broken, "1.2.3.4", crypto.randomUUID())).toBe(true);
  });

  it("captureLead stores a trimmed email", async () => {
    const user = await createUser();
    const link = await utm.recordLink(db(), { userId: user.id, originalUrl: "https://l.com", trackedUrl: "https://l.com", utmParams: {} });
    await ac.captureLead(db(), "  lead@acme.com ", { ip: "", linkId: link.id });
    const row = await env.DB.prepare("SELECT email, ip_address FROM access_leads WHERE link_id = ?").bind(link.id).first();
    expect(row).toEqual({ email: "lead@acme.com", ip_address: null });
  });
});

describe("access pages", () => {
  it("statuses, copy and escaping", async () => {
    const vpn = blockedPage("vpn", { brand: "<b>go.acme.com</b>" });
    expect(vpn.status).toBe(410);
    expect(vpn.headers.get("content-type")).toContain("text/html");
    const body = await vpn.text();
    expect(body).toContain("Access blocked");
    expect(body).toContain("&lt;b&gt;go.acme.com&lt;/b&gt;");
    expect(await blockedPage("whatever").text()).toContain("Link unavailable");

    const gate = emailGatePage({ action: "/r/abc/unlock", error: true });
    expect(gate.status).toBe(200);
    const gateHtml = await gate.text();
    expect(gateHtml).toContain('action="/r/abc/unlock"');
    expect(gateHtml).toContain("Please enter a valid email.");
    expect(gateHtml).toContain('<div class="brand">Champbeam</div>');

    expect(codeGatePage({ action: "/f/x/unlock-code", error: "too_many" }).status).toBe(429);
    expect(await codeGatePage({ action: "/f/x/unlock-code", error: "wrong" }).text()).toContain("That code isn’t right.");
  });
});
