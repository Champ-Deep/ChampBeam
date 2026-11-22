/** Intranet test helpers: an org with Admin, Reviewer and Members, each with a Better Auth session. */
import { env, SELF } from "cloudflare:test";
import { BASE, api, createOrg, createUser, json, sessionHeaders } from "../helpers";

export { api, json, env, BASE };

export interface Member {
  id: string;
  email: string;
  headers: Record<string, string>;
}

export async function member(orgId: string, opts: { role?: string; reviewer?: boolean; name?: string } = {}): Promise<Member> {
  const user = await createUser({ fullName: opts.name ?? null as unknown as string });
  await env.DB.prepare(
    "INSERT INTO organization_memberships (id, organization_id, user_id, role, is_reviewer, status, created_at, updated_at) VALUES (?,?,?,?,?, 'active', ?, ?)",
  )
    .bind(crypto.randomUUID(), orgId, user.id, opts.role ?? "member", opts.reviewer ? 1 : 0, new Date().toISOString(), new Date().toISOString())
    .run();
  return { id: user.id, email: user.email, headers: await sessionHeaders(user.id, orgId) };
}

export async function setupOrg() {
  const org = await createOrg(undefined, "Champions");
  const admin = await member(org.id, { role: "admin", name: "Ada Admin" });
  const reviewer = await member(org.id, { reviewer: true, name: "Rita Reviewer" });
  const alice = await member(org.id, { name: "Alice" });
  const bob = await member(org.id, { name: "Bob" });
  return { orgId: org.id, admin, reviewer, alice, bob };
}

/** Upload bytes through the Worker (no R2 S3 credentials in tests) and submit them as a transfer. */
export async function submit(
  from: Member,
  to: Member,
  opts: { content?: string; filename?: string; oneTime?: boolean; days?: number | null; purpose?: string } = {},
) {
  const content = opts.content ?? `report ${crypto.randomUUID()}`;
  const bytes = new TextEncoder().encode(content);
  const init = await api("/api/v1/intranet/uploads", {
    method: "POST",
    headers: from.headers,
    json: { filename: opts.filename ?? "report.csv", content_type: "text/csv", size_bytes: bytes.length },
  });
  if (init.status !== 201) throw new Error(`upload init ${init.status}: ${await init.text()}`);
  const up = await json(init);
  const put = await SELF.fetch(`${BASE}${up.upload_url}`, { method: "PUT", body: bytes, headers: { "Content-Type": "text/csv", "Content-Length": String(bytes.length) } });
  if (put.status !== 204) throw new Error(`blob put ${put.status}: ${await put.text()}`);
  const res = await api("/api/v1/intranet/transfers", {
    method: "POST",
    headers: from.headers,
    json: {
      file_id: up.file_id,
      recipient_user_id: to.id,
      purpose: opts.purpose ?? "Monthly data drop for the finance team",
      requested_one_time: opts.oneTime ?? false,
      requested_expires_in_days: opts.days ?? null,
    },
  });
  if (res.status !== 201) throw new Error(`submit ${res.status}: ${await res.text()}`);
  return { transfer: await json(res), content, fileId: up.file_id as string };
}

export async function approve(reviewer: Member, id: string, body: Record<string, unknown> = {}) {
  return api(`/api/v1/intranet/review/${id}/approve`, { method: "POST", headers: reviewer.headers, json: body });
}

export async function transferRow(id: string) {
  return env.DB.prepare("SELECT * FROM transfers WHERE id = ?").bind(id).first<Record<string, any>>();
}

export async function logEvents(transferId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT event FROM decision_log WHERE transfer_id = ? ORDER BY id").bind(transferId).all<{ event: string }>();
  return results.map((r) => r.event);
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = await fn();
  }
  return v;
}
