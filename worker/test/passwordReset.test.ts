/**
 * Password reset for migrated Clerk users: a users row with no account row gets its first credential
 * through the emailed link and stays the same user (so every file and link stays attached).
 */
import { describe, expect, it } from "vitest";
import { BASE, env } from "./helpers";
import type { Env } from "../src/env";
import { createAuth } from "../src/auth/betterAuth";
import { getDb } from "../src/db/client";

const sent: { to: string; text: string }[] = [];
const auth = () => createAuth({ ...env, EMAIL: { send: async (m: { to: string; text: string }) => void sent.push(m) } } as unknown as Env, getDb(env.DB));
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
    expect(await accounts(id)).toEqual([]);

    const asked = await post("/request-password-reset", { email, redirectTo: `${BASE}/reset-password` });
    expect(asked.status).toBe(200);
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

    expect((await post("/reset-password", { token, newPassword: "another-password-1" })).status).toBe(400);
  });

  it("answers an unknown email exactly like a known one and sends nothing", async () => {
    const known = await post("/request-password-reset", { email: "returning@championsmail.com", redirectTo: `${BASE}/reset-password` });
    const before = sent.length;
    const unknown = await post("/request-password-reset", { email: "nobody@championsmail.com", redirectTo: `${BASE}/reset-password` });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    expect(sent.length).toBe(before);
  });
});
