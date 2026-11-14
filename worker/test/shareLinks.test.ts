/**
 * Links the app hands out must open, including root-slug URLs already sent on
 * the platform host. A configured share origin is used only after it answers.
 */
import { describe, expect, it, vi } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { clearShareOriginLiveCache, shareOriginIsLive } from "../src/lib/shareOriginLive";
import { newUser, seedFile, seedPage, setSettings } from "./serveSeed";

const HTML = "<!doctype html><html><body><p>hi</p></body></html>";

const liveShare = { shareHosts: ["share.sandbox.test"], resolvedShareHost: "share.sandbox.test", shareOriginReachable: true };
const darkShare = { shareHosts: ["share.sandbox.test"], resolvedShareHost: "share.sandbox.test", shareOriginReachable: false };

describe("link generation without a live share origin", () => {
  it("uses /p/<slug> for HTML and the /f/ URL for other hosted files", async () => {
    const { headers, user } = await authedUser();
    const page = await json(await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "field-notes" }, headers }));
    expect(page.public_url).toBe("https://share.example.com/p/field-notes");
    expect(page.url).toBe("https://share.example.com/p/field-notes");

    const htmlSug = await json(await api("/api/v1/pages/slug-suggestion?filename=Notes.html", { headers }));
    expect(htmlSug.public_url).toBe(`https://share.example.com/p/${htmlSug.slug}`);
    const fileSug = await json(await api("/api/v1/pages/slug-suggestion?filename=Notes.pdf", { headers }));
    expect(fileSug.public_url).toBeNull();

    const file = await seedFile(user.id, {
      kind: "pdf",
      mime: "application/pdf",
      filename: "deck.pdf",
      body: "%PDF",
      slug: "deck-notes",
      share_intent: "host",
    });
    const listed = await json(await api("/api/v1/files", { headers }));
    const row = listed.find((item: { id: string }) => item.id === file.id);
    expect(row.public_url).toBe(`https://share.example.com/f/${file.shortCode}/deck.pdf`);
  });
});

describe("share origin health", () => {
  it("accepts only this worker's healthy payload", async () => {
    clearShareOriginLiveCache();
    let mode: "healthy" | "partial" | "down" = "healthy";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (mode === "down") throw new Error("dns");
      const body = mode === "healthy" ? { status: "healthy", database: "connected" } : { status: "healthy" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    expect(await shareOriginIsLive("share.sandbox.test")).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://share.sandbox.test/health");

    clearShareOriginLiveCache();
    mode = "partial";
    expect(await shareOriginIsLive("share.sandbox.test")).toBe(false);

    clearShareOriginLiveCache();
    mode = "down";
    expect(await shareOriginIsLive("share.other.test")).toBe(false);
  });
});

describe("root slug on the platform host", () => {
  it("serves an active hosted page and a hosted file, and leaves app routes alone", async () => {
    const uid = await newUser();
    await seedPage(uid, HTML, { slug: "root-field" });
    await seedFile(uid, {
      kind: "pdf",
      mime: "application/pdf",
      filename: "deck.pdf",
      body: "%PDF",
      slug: "root-deck",
      share_intent: "host",
    });
    await seedFile(uid, {
      kind: "pdf",
      mime: "application/pdf",
      filename: "secret.pdf",
      body: "nope",
      slug: "root-secret",
      share_intent: "download",
    });

    const page = await api("/root-field");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<p>hi</p>");

    const pdf = await api("/root-deck");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");

    expect((await api("/root-secret")).status).toBe(404);
    for (const path of ["/settings", "/dashboard", "/login", "/team", "/sign-in"]) {
      expect((await api(path)).status, path).toBe(404);
    }

    await env.DB.prepare("UPDATE file_assets SET status = 'deleted' WHERE slug = 'root-field'").run();
    expect((await api("/root-field")).status).toBe(404);
  });

  it("keeps serving on the platform host when the share origin does not answer", async () => {
    setSettings(darkShare as any);
    const { headers } = await authedUser();
    const page = await json(await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "quiet-notes" }, headers }));
    expect(page.public_url).toBe("https://share.example.com/p/quiet-notes");
    expect((await api("/p/quiet-notes")).status).toBe(200);
    const root = await api("/quiet-notes");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<p>hi</p>");
  });

  it("redirects platform root and /p/ links once the share origin answers", async () => {
    setSettings(liveShare as any);
    const { headers, user } = await authedUser();
    const page = await json(await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "live-notes" }, headers }));
    expect(page.public_url).toBe("https://share.sandbox.test/live-notes");

    const root = await api("/live-notes");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("https://share.sandbox.test/live-notes");
    const legacy = await api("/p/live-notes");
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get("location")).toBe("https://share.sandbox.test/p/live-notes");

    const file = await seedFile(user.id, {
      kind: "pdf",
      mime: "application/pdf",
      filename: "deck.pdf",
      body: "%PDF",
      slug: "live-deck",
      share_intent: "host",
    });
    const listed = await json(await api("/api/v1/files", { headers }));
    const row = listed.find((item: { id: string }) => item.id === file.id);
    expect(row.public_url).toBe("https://share.sandbox.test/live-deck");
  });
});
