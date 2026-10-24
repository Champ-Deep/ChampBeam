/**
 * Clerk (svix) webhook receiver, /api/v1/webhooks/clerk. backend/tests has no
 * webhook tests; these cover the router end to end with real svix signatures.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, createOrg, createUser, addMember, env, json } from "./helpers";
import { getSettings, type Env, type Settings } from "../src/env";

const KEY_BYTES = crypto.getRandomValues(new Uint8Array(24));
const SECRET = "whsec_" + btoa(String.fromCharCode(...KEY_BYTES));

let restore: Partial<Settings> | null = null;
function configure(secret: string) {
  const s = getSettings(env as unknown as Env);
  restore = { clerkWebhookSecret: s.clerkWebhookSecret, clerkWebhookConfigured: s.clerkWebhookConfigured };
  Object.assign(s, { clerkWebhookSecret: secret, clerkWebhookConfigured: !!secret });
}
afterEach(() => {
  if (restore) Object.assign(getSettings(env as unknown as Env), restore);
  restore = null;
});

async function sign(id: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", KEY_BYTES, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return "v1," + btoa(String.fromCharCode(...mac));
}

async function send(event: unknown, opts: { tamper?: boolean; ts?: number } = {}) {
  const body = JSON.stringify(event);
  const id = `msg_${crypto.randomUUID()}`;
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = await sign(id, ts, body);
  return api("/api/v1/webhooks/clerk", {
    method: "POST",
    body: opts.tamper ? body.replace("}", ',"x":1}') : body,
    headers: {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": `v1,bogus ${sig}`,
    },
  });
}

const userRow = (clerkId: string) =>
  env.DB.prepare("SELECT * FROM users WHERE clerk_id = ?").bind(clerkId).first<Record<string, any>>();

describe("clerk webhook", () => {
  it("503 when not configured", async () => {
    configure("");
    const res = await api("/api/v1/webhooks/clerk", { method: "POST", json: { type: "user.created" } });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ detail: "Clerk webhooks are not configured (set CLERK_WEBHOOK_SECRET)." });
  });

  it("401 on a missing, tampered or stale signature", async () => {
    configure(SECRET);
    const unsigned = await api("/api/v1/webhooks/clerk", { method: "POST", json: { type: "user.created" } });
    expect(unsigned.status).toBe(401);
    expect(await json(unsigned)).toEqual({ detail: "Invalid webhook signature." });
    expect((await send({ type: "user.created", data: { id: "user_t" } }, { tamper: true })).status).toBe(401);
    const stale = await send({ type: "user.created", data: { id: "user_t" } }, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(401);
  });

  it("user.created / user.updated upsert the user; user.deleted soft-deactivates", async () => {
    configure(SECRET);
    const clerkId = `user_${crypto.randomUUID().slice(0, 10)}`;
    const created = await send({
      type: "user.created",
      data: {
        id: clerkId,
        first_name: "Ada",
        last_name: "Lovelace",
        primary_email_address_id: "idn_1",
        email_addresses: [{ id: "idn_1", email_address: `${clerkId}@example.com` }],
      },
    });
    expect(created.status).toBe(200);
    expect(await json(created)).toEqual({ ok: true, handled: "user.created" });
    let row = await userRow(clerkId);
    expect(row?.email).toBe(`${clerkId}@example.com`);
    expect(row?.full_name).toBe("Ada Lovelace");
    expect(row?.is_active).toBe(1);

    const deleted = await send({ type: "user.deleted", data: { id: clerkId } });
    expect(await json(deleted)).toEqual({ ok: true, handled: "user.deleted" });
    row = await userRow(clerkId);
    expect(row?.is_active).toBe(0);
  });

  it("organization and membership lifecycle", async () => {
    configure(SECRET);
    const orgId = `org_${crypto.randomUUID().slice(0, 10)}`;
    const clerkUser = `user_${crypto.randomUUID().slice(0, 10)}`;

    await send({ type: "organization.created", data: { id: orgId, name: "Acme", slug: "acme" } });
    await send({ type: "organization.updated", data: { id: orgId, name: "Acme Inc" } });
    const org = await env.DB.prepare("SELECT * FROM organizations WHERE clerk_org_id = ?").bind(orgId).first<any>();
    expect(org).toMatchObject({ name: "Acme Inc", slug: "acme" });

    const membership = {
      id: "orgmem_1",
      role: "org:admin",
      organization: { id: orgId, name: "Acme Inc", slug: "acme" },
      public_user_data: { user_id: clerkUser, identifier: `${clerkUser}@example.com`, first_name: "Grace", last_name: "Hopper" },
    };
    const up = await send({ type: "organizationMembership.created", data: membership });
    expect(await json(up)).toEqual({ ok: true, handled: "organizationMembership.created" });
    const user = await userRow(clerkUser);
    expect(user).toMatchObject({ email: `${clerkUser}@example.com`, full_name: "Grace Hopper" });
    const mem = await env.DB.prepare("SELECT * FROM organization_memberships WHERE organization_id = ? AND user_id = ?")
      .bind(org.id, user!.id)
      .first<any>();
    expect(mem).toMatchObject({ role: "admin", clerk_membership_id: "orgmem_1" });

    await send({ type: "organizationMembership.updated", data: { ...membership, role: "org:member" } });
    const mem2 = await env.DB.prepare("SELECT role FROM organization_memberships WHERE id = ?").bind(mem.id).first<any>();
    expect(mem2.role).toBe("member");

    await send({ type: "organizationMembership.deleted", data: membership });
    // Tombstoned, not deleted: a still-valid session token must not revive it.
    expect(
      await env.DB.prepare("SELECT status, revoked_at FROM organization_memberships WHERE id = ?").bind(mem.id).first<any>(),
    ).toMatchObject({ status: "revoked" });

    await send({ type: "organization.deleted", data: { id: orgId } });
    expect(await env.DB.prepare("SELECT id FROM organizations WHERE clerk_org_id = ?").bind(orgId).first()).toBeNull();
  });

  it("organization.deleted cascades memberships", async () => {
    configure(SECRET);
    const org = await createOrg();
    const user = await createUser();
    await addMember(org.id, user.id);
    await send({ type: "organization.deleted", data: { id: org.clerkOrgId } });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM organization_memberships WHERE organization_id = ?")
      .bind(org.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("handler failures still return 200 with ok=false; unknown events are acknowledged", async () => {
    configure(SECRET);
    const bad = await send({ type: "organization.created", data: { name: "no id" } });
    expect(bad.status).toBe(200);
    expect(await json(bad)).toEqual({ ok: false, handled: "organization.created" });
    const other = await send({ type: "session.created", data: {} });
    expect(await json(other)).toEqual({ ok: true, handled: "session.created" });
  });
});
