/** 0010_domain_claim_token.sql: token backfill and active-only unique hostname index. */
import { expect, it } from "vitest";
import sqlText from "../migrations/0010_domain_claim_token.sql?raw";
import { createUser, env } from "./helpers";

const now = new Date().toISOString();
async function insert(userId: string, hostname: string, status: string) {
  await env.DB.prepare("INSERT INTO domains (id, user_id, hostname, status, created_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), userId, hostname, status, now).run();
}
const stmts = sqlText.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

it("backfills non-active rows and enforces active-only uniqueness", async () => {
  // Rewind to the pre-migration shape (test setup already applied it).
  await env.DB.prepare("DROP INDEX idx_domains_hostname_active").run();
  await env.DB.prepare("DROP INDEX idx_domains_hostname_lookup").run();
  await env.DB.prepare("ALTER TABLE domains DROP COLUMN verification_token").run();
  await env.DB.prepare("CREATE UNIQUE INDEX idx_domains_hostname ON domains (hostname)").run();
  await env.DB.prepare("DROP INDEX idx_domains_hostname").run(); // fixture needs duplicates, impossible under the old index

  const u = await createUser();
  await insert(u.id, "a.example.com", "active");
  await insert(u.id, "b.example.com", "pending_cname");
  await insert(u.id, "dup.example.com", "pending");
  await insert(u.id, "dup.example.com", "pending");

  await env.DB.prepare("CREATE INDEX idx_domains_hostname ON domains (hostname)").run(); // so the migration DROP has a target
  for (const s of stmts) await env.DB.prepare(s).run();

  const rows = (await env.DB.prepare("SELECT status, verification_token AS t FROM domains WHERE user_id = ?").bind(u.id).all<{ status: string; t: string | null }>()).results;
  expect(rows).toHaveLength(4);
  for (const r of rows) {
    if (r.status === "active") expect(r.t).toBeNull();
    else expect(r.t).toMatch(/^[0-9a-f]{32}$/);
  }
  expect(new Set(rows.map((r) => r.t)).size).toBe(4); // 3 distinct tokens + NULL

  await expect(insert(u.id, "a.example.com", "active")).rejects.toThrow(/UNIQUE/i);
  await insert(u.id, "b.example.com", "pending"); // pending duplicates are allowed
});
