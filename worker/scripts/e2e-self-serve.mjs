// Scripted end-to-end for self-serve orgs, run against STAGING only:
//   node scripts/e2e-self-serve.mjs            (CB_BASE overrides the default staging origin)
// Needs wrangler auth (it flips email_verified on the staging D1, because staging has no email
// sender yet) and refuses to run against anything but a champbeam-staging host.
import { execFileSync } from "node:child_process";

const BASE = (process.env.CB_BASE ?? "https://champbeam-staging.deep-ae0.workers.dev").replace(/\/+$/, "");
if (!BASE.includes("champbeam-staging")) throw new Error(`refusing to run against ${BASE}`);
const run = Date.now().toString(36);
// Random per run: the repo is public and ROOT is a staging super admin, so no committed password may ever work.
const PW = `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`;
let failed = 0;
const step = (n, title) => console.log(`\n== ${n}. ${title}`);
const check = (ok, what, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

class Client {
  cookie = "";
  constructor(email) { this.email = email; }
  async req(method, path, body) {
    const res = await fetch(BASE + path, {
      method, redirect: "manual",
      headers: { Origin: BASE, "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.includes("session_token="));
    if (set) this.cookie = set.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data, res };
  }
  signUp(name) { return this.req("POST", "/api/auth/sign-up/email", { email: this.email, password: PW, name }); }
}

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "champbeam-staging", "--env", "staging", "--remote", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out.slice(out.indexOf("[")));
}

const A = new Client(`e2e-a-${run}@staging.champbeam.test`);
const B = new Client(`e2e-b-${run}@staging.champbeam.test`);
const ROOT = new Client("e2e-root@staging.champbeam.test");
// ROOT is a staging super admin once verified. Retire any account left by an earlier run (it may have an old
// password) so a fresh one is made with this run's random password, and always end the run unverified.
const resetRoot = () => d1(`UPDATE users SET email_verified = 0 WHERE email = '${ROOT.email}'`);
d1(`UPDATE users SET email = 'e2e-root-old-${run}@staging.champbeam.test', email_verified = 0 WHERE email = '${ROOT.email}'`);

try {
step(0, "config endpoint (anonymous)");
const cfg = await new Client("x").req("GET", "/api/v1/config");
console.log(JSON.stringify(cfg.data));
check(cfg.data?.email_enabled === false && cfg.data?.is_super_admin === false && cfg.data?.can_create_org === false && cfg.data?.platform_host === new URL(BASE).host, "config reports email off, not super admin, platform host");

step(1, "A signs up and is personal");
check((await A.signUp("Aye")).status === 200, "A signed up");
const aSess = await A.req("GET", "/api/auth/get-session");
check(aSess.data?.session?.activeOrganizationId == null, "A has no active org");
const aCtx = await A.req("GET", "/api/v1/org/context");
check(aCtx.status === 403, "A has no org context (Personal workspace)", `status ${aCtx.status}`);
const aMem = d1(`SELECT COUNT(*) AS n FROM organization_memberships WHERE user_id = (SELECT id FROM users WHERE email = '${A.email}')`);
check(aMem[0].results[0].n === 0, "A has 0 memberships (no champions-group auto-join)");
const aSlug = `e2e-a-self-${run}`;
check((await A.req("POST", "/api/auth/organization/create", { name: "A Self", slug: aSlug })).status === 403, "unverified A's own create is refused");
d1(`UPDATE users SET email_verified = 1 WHERE email IN ('${A.email}')`);
console.log("(staging has no email sender, so A's email_verified was set in the staging D1)");
const aSelf = await A.req("POST", "/api/auth/organization/create", { name: "A Self", slug: aSlug });
check(aSelf.status === 403, "verified A's own create is refused (only super admins create orgs)", `status ${aSelf.status}`);
check(d1(`SELECT COUNT(*) AS n FROM organizations WHERE slug = '${aSlug}'`)[0].results[0].n === 0, "no org row was written for A");
const aCfg = await A.req("GET", "/api/v1/config");
check(aCfg.data?.can_create_org === false && aCfg.data?.is_super_admin === false, "config says A cannot create orgs");

step(2, "super admin creates an org with A as first admin");
let rootUp = await ROOT.signUp("Root");
check(rootUp.status === 200, "super admin account signed up");
resetRoot(); // set the precondition before checking it
const notYet = await ROOT.req("GET", "/api/v1/admin/orgs");
check(notYet.status === 403, "unverified listed email is NOT a super admin", `status ${notYet.status}`);
const rootCfg0 = await ROOT.req("GET", "/api/v1/config");
check(rootCfg0.data?.can_create_org === false, "config says unverified listed email cannot create orgs");
d1(`UPDATE users SET email_verified = 1 WHERE email = '${ROOT.email}'`);
const rootCfg = await ROOT.req("GET", "/api/v1/config");
check(rootCfg.data?.is_super_admin === true && rootCfg.data?.can_create_org === true, "config says the super admin can create orgs");
const slug = `e2e-${run}`;
const reserved = await ROOT.req("POST", "/api/auth/organization/create", { name: "Bad", slug: "admin" });
check(reserved.status === 400, "reserved slug 'admin' refused", `status ${reserved.status}`);
const created = await ROOT.req("POST", "/api/v1/admin/orgs", { name: "E2E Org", slug, email: A.email });
check(created.status === 201, "super admin created the org with A as first admin", `status ${created.status}`);
const org1 = created.data.id;
const ctx1 = await A.req("GET", "/api/v1/org/context");
check(ctx1.status === 200 && ctx1.data?.org_id === org1 && ctx1.data?.role === "admin", "A is admin of the org", JSON.stringify({ role: ctx1.data?.role, org_slug: ctx1.data?.org_slug }));

step(3, "A invites B and gets the accept URL");
const inv = await A.req("POST", "/api/v1/org/invitations", { email: B.email, role: "member" });
check(inv.status === 201, "invitation created", `status ${inv.status}`);
console.log("accept_url:", inv.data?.accept_url);
check(inv.data?.accept_url === `${BASE}/accept-invitation/${inv.data?.id}`, "accept URL is on the platform host");
const days = (new Date(inv.data.expiresAt) - Date.now()) / 86_400_000;
check(days > 6.9 && days < 7.1, "expires in 7 days", `${days.toFixed(2)} days`);

step(4, "B signs up and accepts, and is a member");
check((await B.signUp("Bee")).status === 200, "B signed up");
check((await B.req("GET", "/api/v1/org/context")).status === 403, "B is personal before accepting (invite alone grants nothing)");
const wrong = await new Client(`e2e-c-${run}@staging.champbeam.test`);
await wrong.signUp("Sea");
check((await wrong.req("POST", "/api/auth/organization/accept-invitation", { invitationId: inv.data.id })).status === 403, "another account cannot accept B's invitation");
const acc = await B.req("POST", "/api/auth/organization/accept-invitation", { invitationId: inv.data.id });
check(acc.status === 200, "B accepted", `status ${acc.status}`);
const bCtx = await B.req("GET", "/api/v1/org/context");
check(bCtx.data?.org_id === org1 && bCtx.data?.role === "member", "B is a member of the org", JSON.stringify({ role: bCtx.data?.role }));

step(5, "A promotes B");
const members = await A.req("GET", `/api/auth/organization/list-members?organizationId=${org1}`);
const bRow = members.data.members.find((m) => m.user.email === B.email);
const aRow = members.data.members.find((m) => m.user.email === A.email);
const promote = await A.req("POST", "/api/auth/organization/update-member-role", { organizationId: org1, memberId: bRow.id, role: "admin" });
check(promote.status === 200 && promote.data?.role === "admin", "B is now admin", `status ${promote.status}`);

step(6, "the last-admin guard refuses");
await A.req("POST", "/api/auth/organization/update-member-role", { organizationId: org1, memberId: bRow.id, role: "member" });
const selfDemote = await A.req("POST", "/api/auth/organization/update-member-role", { organizationId: org1, memberId: aRow.id, role: "member" });
check(selfDemote.status === 400, "A cannot self-demote as the only admin", `status ${selfDemote.status} ${selfDemote.data?.message ?? ""}`);
const selfRemove = await A.req("POST", "/api/auth/organization/remove-member", { organizationId: org1, memberIdOrEmail: A.email });
check(selfRemove.status === 400, "A cannot be removed as the only admin", `status ${selfRemove.status} ${selfRemove.data?.message ?? ""}`);
const leave = await A.req("POST", "/api/auth/organization/leave", { organizationId: org1 });
check(leave.status === 400, "A cannot leave as the only admin", `status ${leave.status}`);

step(7, "a super admin moves B to another org with their content");
const gen = await B.req("POST", "/api/v1/utm/generate", { base_url: "https://example.com/e2e", utm_source: "e2e" });
check(gen.status === 200 && !!gen.data?.link_id, "B created a link in org 1", gen.data?.short_url);
const dest = await ROOT.req("POST", "/api/v1/admin/orgs", { name: "E2E Dest", slug: `e2e-dest-${run}`, email: ROOT.email });
check(dest.status === 201, "super admin created the destination org", `status ${dest.status}`);
const list = await ROOT.req("GET", "/api/v1/admin/orgs");
const row1 = list.data.orgs.find((o) => o.id === org1);
check(row1?.members === 2 && row1?.links === 1, "org list shows counts for org 1", JSON.stringify({ members: row1?.members, links: row1?.links }));
const bId = d1(`SELECT id FROM users WHERE email = '${B.email}'`)[0].results[0].id;
const mv = await ROOT.req("POST", "/api/v1/admin/members/move", { user_id: bId, from_org_id: org1, to_org_id: dest.data.id });
check(mv.status === 200, "B moved", `status ${mv.status}`);
const after = d1(`SELECT organization_id AS o FROM link_clicks WHERE id = '${gen.data.link_id}'`)[0].results[0].o;
check(after === dest.data.id, "B's link moved to the destination org");
const bCtx2 = await B.req("GET", "/api/v1/org/context");
check(bCtx2.data?.org_id === dest.data.id, "B's open session follows to the destination org");
const still = d1(`SELECT COUNT(*) AS n FROM organization_memberships WHERE organization_id = '${org1}' AND user_id = '${bId}'`)[0].results[0].n;
check(still === 0, "B left the source org");
const audit = d1(`SELECT action FROM admin_audit WHERE target = '${bId}'`)[0].results.map((r) => r.action);
check(audit.includes("member.move"), "audit row written", JSON.stringify(audit));

step(8, "a new link mints on the platform host");
const gen2 = await B.req("POST", "/api/v1/utm/generate", { base_url: "https://example.com/e2e2" });
check(gen2.data?.short_url?.startsWith(`${BASE}/s/`), "new link is on the platform host", gen2.data?.short_url);

step(9, "scale: one redirect on staging");
const url = gen2.data.short_url;
const times = [];
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  const r = await fetch(url, { redirect: "manual", headers: { "user-agent": "e2e-measure" } });
  times.push(performance.now() - t0);
  if (i === 0) check(r.status === 302 && r.headers.get("location") === "https://example.com/e2e2", "redirect works", `status ${r.status}`);
}
times.sort((a, b) => a - b);
console.log(`wall time per redirect from this laptop (network included), ms: p50 ${times[7].toFixed(0)}  p90 ${times[13].toFixed(0)}  max ${times[14].toFixed(0)}`);
const lid = gen2.data.link_id;
const stmts = [];
for (let i = 0; i < 5; i++) {
  stmts.push(
    `SELECT * FROM link_clicks WHERE short_code = '${gen2.data.short_code}' AND domain_id IS NULL`,
    `SELECT 1 FROM click_events WHERE link_id = '${lid}' AND ip_address = '203.0.113.9' LIMIT 1`,
    `UPDATE link_clicks SET click_count = COALESCE(click_count, 0) + 1, last_clicked_at = '${new Date().toISOString()}' WHERE id = '${lid}'`,
    `INSERT INTO click_events (id, link_id, ip_address, user_agent, is_revisit, clicked_at) VALUES ('${crypto.randomUUID()}', '${lid}', '203.0.113.9', 'e2e-d1-measure', 0, '${new Date().toISOString()}')`,
  );
}
const res = d1(stmts.join("; "));
const per = [0, 1, 2, 3].map((k) => res.filter((_, i) => i % 4 === k).map((r) => r.meta.duration));
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const names = ["findLink select", "unique-click select", "counter update", "click_events insert"];
per.forEach((a, k) => console.log(`D1 query time, ${names[k]}: median ${med(a).toFixed(3)} ms  (all: ${a.map((x) => x.toFixed(2)).join(", ")})`));
const total = per.reduce((s, a) => s + med(a), 0);
console.log(`D1 time for the 4 foreground queries of one redirect: ${total.toFixed(3)} ms  ->  ~${Math.floor(1000 / total)} redirects/s through one serialized D1 database (geo enrichment adds ~1 background write)`);
d1(`DELETE FROM click_events WHERE user_agent IN ('e2e-d1-measure', 'e2e-measure')`);

// Proof the fixture is not left privileged: ROOT must be refused before we exit.
resetRoot();
const after403 = await ROOT.req("GET", "/api/v1/admin/orgs");
check(after403.status === 403, "ROOT is no longer a super admin after the run", `status ${after403.status}`);
} finally {
  resetRoot();
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
