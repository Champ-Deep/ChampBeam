/**
 * A content-share copy (services/content.ts mintShare) reuses its master's storage_key. No path the copy's
 * owner (or a version prune) can drive may delete bytes another live row still serves; the last holder
 * going away still frees them.
 */
import { describe, expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { member, newOrgId, setSettings, useRouteTestHooks } from "./orgTestUtils";
import { row, seedFile, seedPage } from "./serveSeed";
import { getDb } from "../src/db/client";
import { getSettings } from "../src/env";
import { sweepExpiredFiles } from "../src/services/fileExpiry";

useRouteTestHooks();

const HTML = "<!doctype html><html><head></head><body><p>v1</p></body></html>";
const exists = async (k: string) => (await env.FILES.head(k)) !== null;
const settle = () => new Promise((r) => setTimeout(r, 400));
async function goneEventually(k: string) {
  for (let i = 0; i < 100; i++) {
    if (!(await exists(k))) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function setup(kind: "file" | "page") {
  const org = newOrgId();
  const admin = await member(org, "admin", "Ada Admin");
  const mark = await member(org, "member", "Mark Member");
  const master = kind === "file"
    ? await seedFile(admin.userId, { kind: "pdf", mime: "application/pdf", filename: "deck.pdf", body: "MASTER" })
    : await seedPage(admin.userId, HTML, { slug: `pg-${org.slice(-6)}` });
  const created = await api("/api/v1/content", { method: "POST", headers: admin.headers, json: { title: "Lib item", kind: "file", file_id: master.id } });
  expect(created.status).toBe(201);
  expect((await api(`/api/v1/content/${(await json(created)).id}/share`, { method: "POST", headers: mark.headers })).status).toBe(201);
  const copy = (await row<{ id: string; storage_key: string; short_code: string }>("SELECT id, storage_key, short_code FROM file_assets WHERE user_id = ?", mark.userId))!;
  expect(copy.storage_key).toBe(master.storageKey);
  return { admin, mark, master, copy };
}

describe("shared storage_key survives a copy's lifecycle", () => {
  it("DELETE /files/{copy} keeps the master's bytes; deleting the master too frees them", async () => {
    const { admin, mark, master, copy } = await setup("file");
    expect((await api(`/api/v1/files/${copy.id}`, { method: "DELETE", headers: mark.headers })).status).toBe(204);
    await settle();
    expect(await exists(master.storageKey)).toBe(true);
    expect((await api(`/f/${master.shortCode}`)).status).toBe(200);
    expect((await api(`/api/v1/files/${master.id}`, { method: "DELETE", headers: admin.headers })).status).toBe(204);
    expect(await goneEventually(master.storageKey)).toBe(true);
  });

  it("PUT /files/{copy}/content keeps the master's bytes", async () => {
    const { mark, master, copy } = await setup("file");
    const r = await api(`/api/v1/files/${copy.id}/content?filename=x.txt`, { method: "PUT", body: new TextEncoder().encode("replacement"), headers: { ...mark.headers, "Content-Type": "text/plain" } });
    expect(r.status).toBe(200);
    await settle();
    expect(await exists(master.storageKey)).toBe(true);
  });

  it("serve-time expiry and the cron sweep of an expired copy keep the master's bytes", async () => {
    for (const via of ["serve", "sweep"] as const) {
      const { mark, master, copy } = await setup("file");
      expect((await api(`/api/v1/files/${copy.id}/access`, { method: "PUT", headers: mark.headers, json: { expires_in_hours: -1 } })).status).toBe(200);
      if (via === "serve") await api(`/f/${copy.short_code}`);
      else await sweepExpiredFiles(env as never, getSettings(env as never), getDb(env.DB));
      await settle();
      expect(await exists(master.storageKey), via).toBe(true);
    }
  });

  it("DELETE /pages/{copy} and a version prune on the master keep the other row's bytes", async () => {
    const a = await setup("page");
    expect((await api(`/api/v1/pages/${a.copy.id}`, { method: "DELETE", headers: a.mark.headers })).status).toBe(204);
    await settle();
    expect(await exists(a.master.storageKey)).toBe(true);

    setSettings({ pagesVersionsKeep: 1 });
    const b = await setup("page");
    expect((await api(`/api/v1/pages/${b.master.id}`, { method: "PUT", headers: b.admin.headers, json: { html: HTML.replace("v1", "v2") } })).status).toBe(200);
    await settle();
    expect(await exists(b.copy.storage_key)).toBe(true);
    expect((await api(`/f/${b.copy.short_code}`)).status).toBe(200);
  });
});
