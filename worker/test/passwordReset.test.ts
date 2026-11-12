/**
 * Password reset for migrated Clerk users: a users row with no account row gets its first credential
 * through the emailed link and stays the same user (so every file and link stays attached).
 */
import { describe, expect, it } from "vitest";
import { BASE, addMember, api, createOrg, env, json } from "./helpers";
import type { Env } from "../src/env";
import { createAuth } from "../src/auth/betterAuth";
import { getDb } from "../src/db/client";

const sent: { to: string; text: string }[] = [];
const pending: Promise<unknown>[] = [];
let sendDelayMs = 0;
const auth = () =>
  createAuth(
    { ...env, EMAIL: { send: async (m: { to: string; text: string }) => { await new Promise((r) => setTimeout(r, sendDelayMs)); sent.push(m); } } } as unknown as Env,
    getDb(env.DB),
    (p) => void pending.push(p),
  );
let ipSeq = 0;
const post = (path: string, body: unknown) =>
  auth().handler(new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: BASE, "cf-connecting-ip": `198.51.101.${++ipSeq}` },
    body: JSON.stringify(body),
  }));

async function migratedUser(email: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO users (id, clerk_id, email, full_name, is_active, email_verified, created_at, updated_at) VALUES (?,?,?,?,1,1,?,?)")
    .bind(id, `user_${id}`, email, "Migrated User", now, now).run();
  return id;
}
const accounts = (userId: string) =>
  env.DB.prepare("SELECT provider_id, account_id FROM account WHERE user_id = ?").bind(userId).all<{ provider_id: string; account_id: string }>().then((r) => r.results);

describe("password reset for a migrated user with no credential", () => {
  it("emails a link, sets the first credential, keeps the same users.id, and the link works once", async () => {
    const email = "returning@championsmail.com";
    const id = await migratedUser(email);
    const org = await createOrg();
    await addMember(org.id, id);
    const fileId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO file_assets (id, user_id, short_code, filename, kind, mime_type, size_bytes, storage_key, status, serve_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(fileId, id, `r${fileId.slice(0, 6)}`, "kept.pdf", "pdf", "application/pdf", 1, "k", "active", "stream", new Date().toISOString()).run();
    expect(await accounts(id)).toEqual([]);

    const asked = await post("/request-password-reset", { email, redirectTo: `${BASE}/reset-password` });
    expect(asked.status).toBe(200);
    await Promise.all(pending); // the mail is sent after the response
    const mail = sent.at(-1)!;
    expect(mail.to).toBe(email);
    const token = /\/reset-password\/([^?\s]+)\?callbackURL=/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();

    const reset = await post("/reset-password", { token, newPassword: "a-brand-new-password" });
    expect(reset.status).toBe(200);
    expect(await accounts(id)).toEqual([{ provider_id: "credential", account_id: id }]);

    const signIn = await post("/sign-in/email", { email, password: "a-brand-new-password" });
    expect(signIn.status).toBe(200);
    expect(((await signIn.json()) as { user: { id: string } }).user.id).toBe(id);
    expect((await env.DB.prepare("SELECT count(*) n FROM users WHERE lower(email) = ?").bind(email).first<{ n: number }>())!.n).toBe(1);

    // The session starts in their own org and their file is still listed.
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    const session = await env.DB.prepare("SELECT active_organization_id a FROM session WHERE user_id = ? ORDER BY created_at DESC").bind(id).first<{ a: string | null }>();
    expect(session!.a).toBe(org.id);
    const files = await json<{ id: string }[]>(await api("/api/v1/files", { headers: { Cookie: cookie, Origin: BASE } }));
    expect(files.map((f) => f.id)).toEqual([fileId]);

    expect((await post("/reset-password", { token, newPassword: "another-password-1" })).status).toBe(400);
  });

  it("answers an unknown email exactly like a known one, as fast, and only mails the known one", async () => {
    const email = "known-reset@championsmail.com";
    await migratedUser(email);
    const ask = async (to: string) => {
      const t = performance.now();
      const res = await post("/request-password-reset", { email: to, redirectTo: `${BASE}/reset-password` });
      return { res, ms: performance.now() - t };
    };
    sendDelayMs = 400; // a slow mailer must not show in the response time
    await Promise.all(pending);
    const before = sent.length;
    const known = await ask(email);
    const unknown = await ask("nobody-here@championsmail.com");
    expect(unknown.res.status).toBe(known.res.status);
    expect(await unknown.res.text()).toBe(await known.res.text());
    expect(Math.abs(known.ms - unknown.ms)).toBeLessThan(150);
    await Promise.all(pending);
    sendDelayMs = 0;
    expect(sent.slice(before).map((m) => m.to)).toEqual([email]);
  });
});
