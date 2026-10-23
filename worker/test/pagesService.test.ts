/** Service-level tests for src/services/pages.ts (port of the pure parts of test_beam_pages.py + version rules). */
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { getSettings } from "../src/env";
import { fileAssets } from "../src/db/schema";
import { HTTPError } from "../src/lib/errors";
import * as pages from "../src/services/pages";
import { createUser, env } from "./helpers";

const db = getDb(env.DB);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function expectHttp(fn: () => unknown, status: number, detail?: string | RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HTTPError);
    expect((e as HTTPError).status).toBe(status);
    if (typeof detail === "string") expect((e as HTTPError).detail).toBe(detail);
    else if (detail) expect(String((e as HTTPError).detail)).toMatch(detail);
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
      shortCode: id.slice(0, 7),
      slug: null,
      filename: "page.html",
      kind: "html",
      mimeType: "text/html",
      sizeBytes: 10,
      sha256: "abc",
      storageKey: `files/${id}/v1.html`,
      status: "active",
      ...over,
    })
    .returning();
  return rows[0];
}

describe("injection", () => {
  it("test_injection_placement", () => {
    const snip = "<script>x</script>";
    expect(dec(pages.injectSnippet(enc("<HTML><HEAD lang=en><title>a</title>"), snip))).toBe(
      `<HTML><HEAD lang=en>${snip}<title>a</title>`,
    );
    expect(dec(pages.injectSnippet(enc("<html><body>no head</body></html>"), snip))).toBe(
      `<html>${snip}<body>no head</body></html>`,
    );
    expect(dec(pages.injectSnippet(enc("plain text"), snip))).toBe(`${snip}plain text`);
    // string overload, and <header> is not <head>
    expect(pages.injectSnippet("<header>x</header>", snip)).toBe(`${snip}<header>x</header>`);
  });

  it("splices at the right byte offset with multi-byte content before <head>", () => {
    const out = pages.injectSnippet(enc("<!-- é漢 --><head>t"), "S");
    expect(dec(out)).toBe("<!-- é漢 --><head>St");
  });

  it("test_snippet_escapes_script_close", () => {
    const s = pages.trackingSnippet({ visitorId: "v</script><b>", pageId: "p", beaconUrl: "/f/x/page-events" });
    expect(s.split("</script>")[0]).not.toContain("</script><b>");
    expect(s.startsWith('<script>(function(){var C={"v":"v<\\/script><b>","p":"p","u":"/f/x/page-events"};')).toBe(true);
    expect(s.endsWith("})();</script>")).toBe(true);
  });

  it("jsonForScript matches Python json.dumps ensure_ascii", () => {
    expect(pages.jsonForScript({ a: "é" })).toBe('{"a":"\\u00e9"}');
    expect(pages.pyJsonDumps([1, "x"])).toBe('[1,"x"]');
  });

  it("state snippet only with a token; ident prefers slug", () => {
    expect(pages.stateSnippetJs({ stateToken: null, slug: "a", shortCode: "b" })).toBe("");
    const js = pages.stateSnippetJs({ stateToken: "tok", slug: "my-page", shortCode: "abc" });
    expect(js.startsWith(`window.__BEAM__={page:"my-page",token:"tok",api:'/api/pages'};`)).toBe(true);
    expect(pages.stateSnippetJs({ stateToken: "tok", slug: null, shortCode: "abc" })).toContain('page:"abc"');
  });

  it("visitor ids", () => {
    const v = pages.newVisitorId();
    expect(v).toHaveLength(22);
    expect(pages.validVisitorId(v)).toBe(v);
    expect(pages.validVisitorId("short")).toBeNull();
    expect(pages.validVisitorId("bad id with spaces")).toBeNull();
    expect(pages.validVisitorId(null)).toBeNull();
  });
});

describe("slugs", () => {
  it("validateSlug normalizes and enforces rules", () => {
    expect(pages.validateSlug("  My-Page ")).toBe("my-page");
    expectHttp(() => pages.validateSlug("-bad"), 400, /Slug must be 3–60/);
    expectHttp(() => pages.validateSlug("ab"), 400);
    expectHttp(() => pages.validateSlug("admin"), 400, "'admin' is reserved.");
  });

  it("slugify", () => {
    expect(pages.slugify("Pallab North Star!")).toBe("pallab-north-star");
    expect(pages.slugify("")).toBe("page");
    expect(pages.slugify("a")).toBe("a-page");
    expect(pages.slugify("API")).toBe("api-page");
    expect(pages.slugify("x".repeat(80))).toHaveLength(60);
  });

  it("slugTaken / uniqueSlug are namespace-scoped and ignore deleted rows", async () => {
    const user = await createUser();
    const a = await insertAsset(user.id, { slug: "taken-slug" });
    expect(await pages.slugTaken(db, "taken-slug", null)).toBe(true);
    expect(await pages.slugTaken(db, "taken-slug", null, { excludeId: a.id })).toBe(false);
    const next = await pages.uniqueSlug(db, "Taken Slug", null);
    expect(next).toMatch(/^taken-slug-[a-z0-9]{6}$/);
    await insertAsset(user.id, { slug: "gone-slug", status: "deleted" });
    expect(await pages.slugTaken(db, "gone-slug", null)).toBe(false);
  });
});

describe("validateHtmlUpload", () => {
  const settings = getSettings(env as never);
  const ok = enc("<html><body>hi</body></html>");

  it("accepts plain html", () => {
    pages.validateHtmlUpload(settings, "a.html", "text/html; charset=utf-8", ok);
    pages.validateHtmlUpload(settings, "a.htm", null, ok);
  });

  it("rejects server code, wrong types, empty and oversize", () => {
    expectHttp(() => pages.validateHtmlUpload(settings, "x.php", null, ok), 400, /^\.php files can't be hosted/);
    expectHttp(() => pages.validateHtmlUpload(settings, "a.html", "text/plain", ok), 400, "Content type must be text/html (got text/plain).");
    expectHttp(() => pages.validateHtmlUpload(settings, "a.txt", null, ok), 400, "Only .html files can be published.");
    expectHttp(() => pages.validateHtmlUpload(settings, "a.html", "text/html", enc(" \n\t")), 400, "The page is empty.");
    expectHttp(
      () => pages.validateHtmlUpload({ pagesMaxBytes: 2 * 1024 * 1024 }, "a.html", "text/html", new Uint8Array(2 * 1024 * 1024 + 1).fill(65)),
      413,
      "Page exceeds the 2 MB limit. Pages must be a single HTML file.",
    );
    expectHttp(
      () => pages.validateHtmlUpload(settings, "a.html", "text/html", enc("<html><?PHP echo 1; ?>")),
      400,
      /found '<\?php'/,
    );
    expectHttp(() => pages.validateHtmlUpload(settings, "a.html", "text/html", enc("<% x %>")), 400, /found '<%'/);
  });
});

describe("versions", () => {
  it("record, swap, rollback-style swap, prune (test_versions_rollback_and_prune rules)", async () => {
    const user = await createUser();
    const asset = await insertAsset(user.id, { slug: "ver-page", storageKey: "k1" });
    await pages.recordVersion(db, asset, { storageKey: "k1", sizeBytes: 5, sha256: "h1", filename: "page.html" });
    expect(await pages.currentVersionNo(db, asset)).toBe(1);

    for (const n of [2, 3, 4]) {
      const r = await pages.replaceContent(db, asset, { storageKey: `k${n}`, sizeBytes: n, sha256: `h${n}`, filename: "page.html" }, { keep: 10, snapshot: true });
      expect(r.version.versionNo).toBe(n);
      expect(r.doomed).toEqual([]);
    }
    expect((await pages.listVersions(db, asset)).map((v) => v.versionNo)).toEqual([4, 3, 2, 1]);
    expect(await pages.currentVersionNo(db, asset)).toBe(4);
    const row = (await db.select().from(fileAssets)).find((a) => a.id === asset.id)!;
    expect(row.storageKey).toBe("k4");
    expect(row.sizeBytes).toBe(4);

    // rollback to v1 = new version pointing at a copy of v1's bytes
    await pages.replaceContent(db, asset, { storageKey: "k5", sizeBytes: 5, sha256: "h1", filename: "page.html" }, { keep: 10 });
    expect(await pages.currentVersionNo(db, asset)).toBe(5);

    const r = await pages.replaceContent(db, asset, { storageKey: "k6", sizeBytes: 6, sha256: "h6", filename: "page.html" }, { keep: 2 });
    expect((await pages.listVersions(db, asset)).map((v) => v.versionNo)).toEqual([6, 5]);
    expect(r.doomed.sort()).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("pruneVersions never returns the live key or a kept key", async () => {
    const user = await createUser();
    const asset = await insertAsset(user.id, { storageKey: "live" });
    await pages.recordVersion(db, asset, { storageKey: "live", sizeBytes: 1, sha256: null, filename: "a.html" });
    await pages.recordVersion(db, asset, { storageKey: "old", sizeBytes: 1, sha256: null, filename: "a.html" });
    await pages.recordVersion(db, asset, { storageKey: "kept", sizeBytes: 1, sha256: null, filename: "a.html" });
    expect(await pages.pruneVersions(db, asset, 1)).toEqual(["old"]);
    expect((await pages.listVersions(db, asset)).map((v) => v.versionNo)).toEqual([3]);
  });

  it("legacy upload: ensureSlug mints + persists, first replace snapshots v1 (test_legacy_upload_gets_slug...)", async () => {
    const user = await createUser();
    const asset = await insertAsset(user.id, { storageKey: "orig", sha256: "o" });
    expect(await pages.currentVersionNo(db, asset)).toBe(0);
    expect(await pages.ensureSlug(db, asset, "Pallab North Star")).toBe(true);
    expect(asset.slug).toBe("pallab-north-star");
    expect(await pages.ensureSlug(db, asset, "Other")).toBe(false);
    const stored = (await db.select().from(fileAssets)).find((a) => a.id === asset.id)!;
    expect(stored.slug).toBe("pallab-north-star");

    const r = await pages.replaceContent(db, asset, { storageKey: "v2", sizeBytes: 2, sha256: "x", filename: "page.html" }, { keep: 10, snapshot: true });
    expect(r.version.versionNo).toBe(2);
    const versions = await pages.listVersions(db, asset);
    expect(versions.map((v) => [v.versionNo, v.storageKey])).toEqual([[2, "v2"], [1, "orig"]]);
    // snapshotIfUnversioned is a no-op once history exists
    expect(await pages.snapshotIfUnversioned(db, asset)).toBeNull();
  });
});
