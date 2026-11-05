/** worker/scripts/lakeb2b_org_backfill.sql: only ACTIVE members' pre-cutoff content moves into the org. */
import { expect, it } from "vitest";
import sqlText from "../scripts/lakeb2b_org_backfill.sql?raw";
import { addMember, createOrg, createUser, env } from "./helpers";

async function link(userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO link_clicks (id, user_id, original_url, tracked_url, short_code, click_count, unique_clicks, created_at) VALUES (?,?,?,?,?,0,0,?)")
    .bind(id, userId, "https://example.com/", "https://example.com/?utm_source=x", `b${id.slice(0, 7)}`, new Date().toISOString()).run();
  return id;
}

it("a revoked member's personal links stay personal; an active member's move", async () => {
  const org = await createOrg();
  const active = await createUser();
  const revoked = await createUser();
  await addMember(org.id, active.id);
  await addMember(org.id, revoked.id);
  await env.DB.prepare("UPDATE organization_memberships SET status = 'revoked' WHERE user_id = ?").bind(revoked.id).run();
  const a = await link(active.id);
  const r = await link(revoked.id);

  const sql = sqlText.replaceAll(":org_id", org.clerkOrgId).replaceAll(":before", "2999-01-01T00:00:00.000Z");
  const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
  for (const s of statements) await env.DB.prepare(s).run();

  const orgOf = async (id: string) => (await env.DB.prepare("SELECT organization_id AS o FROM link_clicks WHERE id = ?").bind(id).first<{ o: string | null }>())!.o;
  expect(await orgOf(a)).toBe(org.id);
  expect(await orgOf(r)).toBeNull();
});
