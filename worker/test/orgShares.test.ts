/**
 * Org-scoped sharing: explicit permission map, revoked-membership tombstones,
 * org-owned domains, share-origin isolation, root-slug hosting, download intent
 * and retired-slug aliases. Fixtures: a migrated in-memory D1 + R2 and a
 * test-key-signed Clerk JWT; no real Clerk, DNS or Cloudflare is involved.
 */
import { describe, expect, it } from "vitest";
import { roleHas } from "../src/auth/permissions";
import { api, env, json } from "./helpers";
import { member, newOrgId, useRouteTestHooks } from "./orgTestUtils";
import { iso, newUser, row, seedFile, seedPage, setSettings } from "./serveSeed";

useRouteTestHooks();

const HTML = "<!doctype html><html><body><p>hi</p></body></html>";

/** An org-owned domain; user_id is the admin who connected it. */
async function orgDomain(clerkOrgId: string, hostname: string, creatorId: string) {
  const org = await row<{ id: string }>("SELECT id FROM organizations WHERE clerk_org_id = ?", clerkOrgId);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO domains (id, user_id, hostname, status, is_primary, created_at, provision_attempts, auto_renew, organization_id, is_org_default) VALUES (?,?,?,?,0,?,0,0,?,1)`,
  )
    .bind(id, creatorId, hostname, "active", iso(), org!.id)
    .run();
  return { id, orgId: org!.id };
}

describe("permission map", () => {
  it("never grants admin by role-name suffix", () => {
    expect(roleHas("admin", "org.domains.manage")).toBe(true);
    expect(roleHas("billing_admin", "org.domains.manage")).toBe(false);
    expect(roleHas("superadmin", "org.members.manage")).toBe(false);
    expect(roleHas("leader", "team.manage")).toBe(true);
    expect(roleHas("leader", "org.domains.manage")).toBe(false);
    expect(roleHas("viewer", "share.create")).toBe(false);
    expect(roleHas(undefined, "share.create")).toBe(true); // unknown -> member, not admin
    expect(roleHas(undefined, "org.members.manage")).toBe(false);
  });
});

describe("membership revocation", () => {
  it("a revoked member's still-valid token loses org access and is not revived", async () => {
    const org = newOrgId();
    await member(org, "admin");
    const rep = await member(org, "member");
    expect((await api("/api/v1/org/context", { headers: rep.headers })).status).toBe(200);
    await env.DB.prepare("UPDATE organization_memberships SET status='revoked' WHERE user_id = ?").bind(rep.userId).run();
    const after = await api("/api/v1/org/members", { headers: rep.headers });
    expect([401, 403]).toContain(after.status);
    // And it cannot mint shares under the org any more (token org claim ignored).
    const d = await orgDomain(org, "rev.acme.test", rep.userId);
    const mint = await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "rev-one", domain_id: d.id }, headers: rep.headers });
    expect(mint.status).toBe(400);
    expect((await row("SELECT status FROM organization_memberships WHERE user_id = ?", rep.userId))?.status).toBe("revoked");
  });

  it("a role changed by Clerk wins over an older token for a webhook-managed row", async () => {
    const org = newOrgId();
    const admin = await member(org, "admin");
    await env.DB.prepare("UPDATE organization_memberships SET clerk_membership_id='mem_1', role='member' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const r = await api("/api/v1/org/members/" + admin.userId, { method: "PATCH", json: { role: "member" }, headers: admin.headers });
    expect(r.status).toBe(403); // token still says admin, mirror says member
  });
});

describe("org domains", () => {
  it("members publish on the org domain; outsiders and viewers cannot", async () => {
    const org = newOrgId();
    const admin = await member(org, "admin");
    const rep = await member(org, "member");
    const viewer = await member(org, "viewer");
    const outsider = await member(newOrgId(), "admin");
    const d = await orgDomain(org, "go.acme.test", admin.userId);

    const ok = await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "acme-one", domain_id: d.id }, headers: rep.headers });
    expect(ok.status).toBe(201);
    const page = await row("SELECT organization_id, share_intent, domain_id FROM file_assets WHERE slug = 'acme-one'");
    expect(page).toMatchObject({ organization_id: d.orgId, share_intent: "host", domain_id: d.id });
    expect((await json(ok)).public_url).toBe("https://go.acme.test/acme-one");

    for (const s of [viewer, outsider]) {
      const r = await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "nope-" + s.userId.slice(0, 4), domain_id: d.id }, headers: s.headers });
      expect(r.status).toBe(400);
    }
  });

  it("an org domain serves only what was shared on it", async () => {
    const org = newOrgId();
    const admin = await member(org, "admin");
    const d = await orgDomain(org, "go.acme2.test", admin.userId);
    await seedPage(admin.userId, HTML, { slug: "personal-page" }); // admin's own platform page
    const miss = await api("https://go.acme2.test/personal-page");
    expect(miss.status).toBe(404);
  });
});

describe("share origin", () => {
  it("serves hosted pages at /<slug> and exposes no control plane", async () => {
    setSettings({ shareHosts: ["share.sandbox.test"], resolvedShareHost: "share.sandbox.test" } as any);
    const uid = await newUser();
    await seedPage(uid, HTML, { slug: "launch-deck" });
    const page = await api("https://share.sandbox.test/launch-deck");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<p>hi</p>");
    for (const p of ["/api/v1/auth/me", "/api/v1/pages", "/login", "/"]) {
      expect((await api("https://share.sandbox.test" + p)).status, p).toBe(404);
    }
    // The control host still works.
    expect((await api("/api/v1/auth/me")).status).toBe(401);
  });

  it("legacy executable /p links on the control host move to the share origin", async () => {
    setSettings({ shareHosts: ["share.sandbox.test"], resolvedShareHost: "share.sandbox.test" } as any);
    const uid = await newUser();
    await seedPage(uid, HTML, { slug: "old-link" });
    const r = await api("/p/old-link");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://share.sandbox.test/p/old-link");
  });

  it("without SHARE_ORIGIN_HOSTS nothing changes", async () => {
    const uid = await newUser();
    await seedPage(uid, HTML, { slug: "plain" });
    expect((await api("/p/plain")).status).toBe(200);
  });
});

describe("download vs host intent", () => {
  it("download intent and ?dl=1 force attachment; legacy defaults are unchanged", async () => {
    const uid = await newUser();
    const legacy = await seedFile(uid, { kind: "pdf", mime: "application/pdf", filename: "a.pdf", body: "x" });
    const sent = await seedFile(uid, { kind: "pdf", mime: "application/pdf", filename: "b.pdf", body: "x", share_intent: "download" });
    const other = await seedFile(uid, { kind: "other", mime: "application/zip", filename: "c.zip", body: "x" });
    const cd = async (u: string) => (await api(u)).headers.get("content-disposition") ?? "";
    expect(await cd(`/f/${legacy.shortCode}`)).toMatch(/^inline/);
    expect(await cd(`/f/${legacy.shortCode}?dl=1`)).toMatch(/^attachment/);
    expect(await cd(`/f/${sent.shortCode}`)).toMatch(/^attachment/);
    expect(await cd(`/f/${other.shortCode}?dl=0`)).toMatch(/^attachment/);
  });
});

describe("slugs", () => {
  it("suggests from the filename and numbers collisions", async () => {
    const org = newOrgId();
    const rep = await member(org, "member");
    await seedPage(rep.userId, HTML, { slug: "quarterly-brief" });
    const r = await json(await api("/api/v1/pages/slug-suggestion?filename=Quarterly%20Brief.pdf", { headers: rep.headers }));
    expect(r).toMatchObject({ slug: "quarterly-brief-2", base: "quarterly-brief", collided: true });
  });

  it("a renamed page keeps answering at its old slug", async () => {
    const org = newOrgId();
    const rep = await member(org, "member");
    const created = await json(await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "first-name" }, headers: rep.headers }));
    expect((await api("/p/first-name")).status).toBe(200);
    const moved = await api(`/api/v1/pages/${created.page_id}`, { method: "PATCH", json: { slug: "second-name" }, headers: rep.headers });
    expect(moved.status).toBe(200);
    expect((await api("/p/second-name")).status).toBe(200);
    expect((await api("/p/first-name")).status).toBe(200);
    const taken = await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "first-name" }, headers: rep.headers });
    expect(taken.status).toBe(409);
  });
});
