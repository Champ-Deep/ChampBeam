// Seed the intranet (ACC-1): create the organization and an Admin invite for the first admin, then print the
// invite link. Nobody can sign up without an invite, so this is the only way in for the first person.
//
//   node scripts/intranet-bootstrap.mjs --email it.admin@champions.example --origin https://champbeam-intranet.<sub>.workers.dev [--org "Champions Group"] [--local]
//
// --local writes to the local `wrangler dev --env intranet` database instead of the remote D1.
// Re-running creates a fresh invite (the old pending one is revoked); the org is reused.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const email = (arg("email") || "").trim().toLowerCase();
const origin = (arg("origin") || "").replace(/\/+$/, "");
const orgName = arg("org", "Champions Group");
const slug = arg("slug", "champions-intranet");
const local = process.argv.includes("--local");
const reviewer = !process.argv.includes("--not-reviewer");
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !/^https?:\/\//.test(origin)) {
  console.error("usage: node scripts/intranet-bootstrap.mjs --email <first admin email> --origin <intranet origin> [--org <name>] [--local]");
  process.exit(2);
}

const worker = fileURLToPath(new URL("..", import.meta.url));
// Run wrangler through node directly: a shell would split SQL arguments on spaces (Windows).
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
function d1(sql, json = false) {
  const args = [WRANGLER, "d1", "execute", "DB", "--env", "intranet", local ? "--local" : "--remote", "--command", sql];
  if (json) args.push("--json");
  const r = spawnSync(process.execPath, args, { cwd: worker, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    process.exit(r.status ?? 1);
  }
  return json ? JSON.parse(r.stdout) : r.stdout;
}

const now = new Date().toISOString();
const existing = d1(`SELECT id FROM organizations WHERE slug = ${q(slug)}`, true)[0]?.results?.[0];
const orgId = existing?.id ?? randomUUID();
if (!existing) {
  d1(`INSERT INTO organizations (id, clerk_org_id, name, slug, created_at, updated_at) VALUES (${q(orgId)}, ${q(randomUUID())}, ${q(orgName)}, ${q(slug)}, ${q(now)}, ${q(now)})`);
  console.log(`created organization ${orgName} (${orgId})`);
} else console.log(`using organization ${slug} (${orgId})`);

const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
d1(
  `UPDATE org_invites SET revoked_at = ${q(now)} WHERE organization_id = ${q(orgId)} AND email = ${q(email)} AND revoked_at IS NULL AND accepted_at IS NULL;
   INSERT INTO org_invites (id, organization_id, email, role, is_reviewer, token_hash, created_at, expires_at)
   VALUES (${q(randomUUID())}, ${q(orgId)}, ${q(email)}, 'admin', ${reviewer ? 1 : 0}, ${q(tokenHash)}, ${q(now)}, ${q(expires)});`,
);
console.log(`\nFirst admin invite for ${email} (expires ${expires}):\n\n  ${origin}/accept-invite?token=${token}\n`);
console.log(`Set INTRANET_ORG_IDS to ${orgId} (or ${slug}) in wrangler.jsonc env.intranet.vars to lock the deployment to this org.`);
