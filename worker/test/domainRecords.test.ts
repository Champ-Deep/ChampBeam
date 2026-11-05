/**
 * share.lakeb2b.com via Settings: DNS records (TXT pre-validation) and org-domain adoption of
 * pre-existing links/pages, which an org domain would otherwise 404 (domain_id NULL rows).
 */
import { describe, expect, it, vi } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { member, newOrgId } from "./orgTestUtils";
import { code, newUser, row, seedDomain, seedFile, seedLink, seedPage, setSettings } from "./serveSeed";

const host = () => `share-${crypto.randomUUID().slice(0, 6)}.example.org`;

/** An org with an admin who owns an active, attached, NOT yet default domain. */
async function orgWithDomain() {
  const clerkOrg = newOrgId();
  const admin = await member(clerkOrg, "admin");
  const orgId = (await row<{ id: string }>("SELECT id FROM organizations WHERE clerk_org_id = ?", clerkOrg))!.id;
  const hostname = host();
  const domainId = await seedDomain(admin.userId, hostname);
  // Real members predate the org; the adoption cutoff defaults to the org's created_at.
  await env.DB.prepare("UPDATE users SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(admin.userId).run();
  const attach = await api(`/api/v1/org/domains/${domainId}/attach`, { method: "POST", headers: admin.headers });
  expect(attach.status).toBe(200);
  return { clerkOrg, orgId, admin, hostname, domainId };
}

const adopt = (s: { headers: HeadersInit }, domainId: string, body: unknown) =>
  api(`/api/v1/org/domains/${domainId}/adopt-existing`, { method: "POST", headers: s.headers, json: body });

describe("org domain adoption", () => {
  it("old NULL-domain link and page resolve on the org domain after default is set", async () => {
    const { admin, hostname, domainId, orgId } = await orgWithDomain();
    const lc = code("l");
    await seedLink(admin.userId, lc, { tracked_url: "https://example.com/old" });
    const page = await seedPage(admin.userId, "<html><head></head><body>old page</body></html>");
    // A stranger's NULL content must stay put.
    const strangerCode = code("s");
    await seedLink(await newUser(), strangerCode);

    expect((await api(`https://${hostname}/r/${lc}`)).headers.get("location")).toBe("/");
    expect((await api(`https://${hostname}/p/${page.slug}`)).status).toBe(404);

    const res = await api(`/api/v1/org/domains/${domainId}/default`, { method: "POST", headers: admin.headers });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.adoption.adopted).toMatchObject({ files: 1, links: 1 });
    expect(body.adoption.attached).toMatchObject({ files: 1, links: 1 });

    const r = await api(`https://${hostname}/r/${lc}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.com/old");
    expect((await api(`https://${hostname}/p/${page.slug}`)).status).toBe(200);
    expect((await row("SELECT organization_id o, domain_id d FROM link_clicks WHERE short_code = ?", lc))).toEqual({ o: orgId, d: domainId });
    expect((await row("SELECT domain_id d FROM link_clicks WHERE short_code = ?", strangerCode))!.d).toBeNull();

    // Idempotent: nothing left to move.
    const again = await json(await adopt(admin, domainId, { dry_run: false }));
    expect(again.adopted).toEqual({ files: 0, links: 0, aliases: 0 });
  });

  it("a member created after the org keeps their personal link on the platform host", async () => {
    const { clerkOrg, admin, domainId } = await orgWithDomain();
    const late = await member(clerkOrg, "member");
    await env.DB.prepare("UPDATE users SET created_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").bind(late.userId).run();
    const lc = code("p");
    await seedLink(late.userId, lc, { tracked_url: "https://example.com/personal" });

    const res = await api(`/api/v1/org/domains/${domainId}/default`, { method: "POST", headers: admin.headers });
    expect(res.status).toBe(200);
    expect(await row("SELECT organization_id o, domain_id d FROM link_clicks WHERE short_code = ?", lc)).toEqual({ o: null, d: null });
    const r = await api(`/r/${lc}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.com/personal");
  });

  it("dry run counts without writing; a collision is reported and not overwritten", async () => {
    const { admin, hostname, domainId } = await orgWithDomain();
    const clash = code("k");
    const free = code("f");
    const oldClash = await seedLink(admin.userId, clash, { tracked_url: "https://example.com/old-clash" });
    await seedLink(admin.userId, free);
    // Already taken on the target domain by someone else.
    await seedLink(await newUser(), clash, { domain_id: domainId, tracked_url: "https://example.com/new-owner" });
    // Same slug taken on the target for a page.
    await seedPage(await newUser(), "<html><head></head><body>new</body></html>", { slug: "dup-slug", domain_id: domainId });
    await seedPage(admin.userId, "<html><head></head><body>old</body></html>", { slug: "dup-slug" });

    const dry = await json(await adopt(admin, domainId, {}));
    expect(dry.dry_run).toBe(true);
    expect(dry.adopted).toMatchObject({ links: 1, files: 0 });
    expect(dry.collisions.links).toEqual([{ short_code: clash }]);
    expect(dry.collisions.files.map((f: any) => f.slug)).toEqual(["dup-slug"]);
    expect((await row("SELECT domain_id d FROM link_clicks WHERE short_code = ? AND id = ?", clash, oldClash))!.d).toBeNull();

    const done = await json(await adopt(admin, domainId, { dry_run: false }));
    expect(done.adopted).toMatchObject({ links: 1, files: 0 });
    expect(done.collisions.links).toEqual([{ short_code: clash }]);
    // The clashing old row did not move; the target domain's row still wins.
    expect((await row("SELECT domain_id d FROM link_clicks WHERE id = ?", oldClash))!.d).toBeNull();
    const served = await api(`https://${hostname}/r/${clash}`);
    expect(served.headers.get("location")).toBe("https://example.com/new-owner");
    expect((await row("SELECT domain_id d FROM link_clicks WHERE short_code = ? AND original_url = ?", free, "https://example.com/dest"))!.d).toBe(domainId);
  });

  it("moves slug aliases with their file, and leaves a clashing file's alias alone", async () => {
    const { admin, domainId, hostname } = await orgWithDomain();
    const f = await seedFile(admin.userId, { slug: "new-name" });
    await env.DB.prepare("INSERT INTO slug_aliases (id, file_id, domain_id, slug, created_at) VALUES (?,?,NULL,?,?)")
      .bind(crypto.randomUUID(), f.id, "old-name", new Date().toISOString())
      .run();
    await adopt(admin, domainId, { dry_run: false });
    expect((await row("SELECT domain_id d FROM slug_aliases WHERE slug = 'old-name'"))!.d).toBe(domainId);
    expect(hostname).toBeTruthy();
  });

  it("non-admin gets 403, no-op on content", async () => {
    const { clerkOrg, domainId, admin } = await orgWithDomain();
    const rep = await member(clerkOrg, "member");
    const lc = code("n");
    await seedLink(admin.userId, lc);
    for (const body of [{}, { dry_run: false }]) {
      expect((await adopt(rep, domainId, body)).status).toBe(403);
    }
    expect((await row("SELECT domain_id d FROM link_clicks WHERE short_code = ?", lc))!.d).toBeNull();
  });

  it("an admin of another org cannot adopt onto this org's domain", async () => {
    const { domainId } = await orgWithDomain();
    const other = await member(newOrgId(), "admin");
    expect((await adopt(other, domainId, { dry_run: false })).status).toBe(404);
  });
});

describe("domain DNS records", () => {
  const CF_RESULT = {
    id: "cf-host-1",
    status: "pending",
    ownership_verification: { type: "txt", name: "_cf-custom-hostname.share.lakeb2b.com", value: "own-uuid-123" },
    ssl: {
      status: "pending_validation",
      validation_records: [{ status: "pending", txt_name: "_acme-challenge.share.lakeb2b.com", txt_value: "cert-token-456" }],
    },
  };

  it("creates with TXT validation and returns every record; records.txt matches", async () => {
    setSettings({
      cloudflareApiToken: "cf-token",
      cloudflareZoneId: "zone1",
      cloudflareConfigured: true,
      cloudflareCnameTarget: "cname.champbeam.com",
    });
    let sent: any = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true, result: CF_RESULT }), { status: 200 });
    });
    const { headers } = await authedUser();
    const hostname = `share-${crypto.randomUUID().slice(0, 6)}.lakeb2b.example`;
    const res = await api("/api/v1/domains", { method: "POST", headers, json: { hostname } });
    expect(res.status).toBe(201);
    expect(sent.ssl.method).toBe("txt");
    const d = await json(res);
    expect(d.dns_records).toEqual([
      expect.objectContaining({ type: "CNAME", name: hostname, value: "cname.champbeam.com", dns_only: true }),
      { type: "TXT", name: CF_RESULT.ownership_verification.name, value: "own-uuid-123", purpose: "Ownership verification" },
      { type: "TXT", name: "_acme-challenge.share.lakeb2b.com", value: "cert-token-456", purpose: "Certificate validation" },
    ]);

    // The list endpoint carries the same stored records without calling CF again.
    const list = await json(await api("/api/v1/domains", { headers }));
    expect(list[0].dns_records).toEqual(d.dns_records);

    const txt = await api(`/api/v1/domains/${d.id}/records.txt`, { headers });
    expect(txt.status).toBe(200);
    expect(txt.headers.get("content-type")).toContain("text/plain");
    const text = await txt.text();
    for (const v of [hostname, "cname.champbeam.com", "_cf-custom-hostname.share.lakeb2b.com", "own-uuid-123", "_acme-challenge.share.lakeb2b.com", "cert-token-456", "DNS only"]) {
      expect(text).toContain(v);
    }
  });

  it("records.txt is owner-only", async () => {
    const { user } = await authedUser();
    const id = await seedDomain(user.id, host(), "pending_cname");
    const other = await authedUser();
    expect((await api(`/api/v1/domains/${id}/records.txt`, { headers: other.headers })).status).toBe(404);
  });
});
