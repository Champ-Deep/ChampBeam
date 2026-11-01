// Adds every Clerk user created before BEFORE to one Clerk organization as org:member.
// Dry run unless --apply. Re-runnable: users who are already members are skipped.
//   CLERK_SECRET_KEY=... ORG_ID=org_... [BEFORE=2026-10-26T00:00:00Z] node scripts/clerk_bulk_membership.mjs [--apply]
// Clerk webhooks (worker/src/routes/webhooks.ts) write the D1 membership rows afterwards.
const API = "https://api.clerk.com/v1";
const PAGE = 500;

export async function run({ env, apply, fetch: f = fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const { CLERK_SECRET_KEY: key, ORG_ID: org } = env;
  if (!key || !org) throw new Error("CLERK_SECRET_KEY and ORG_ID are required");
  const before = env.BEFORE ? Date.parse(env.BEFORE) : Date.now();
  if (Number.isNaN(before)) throw new Error(`BEFORE is not a date: ${env.BEFORE}`);

  const call = async (path, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
      if (res.status !== 429 || attempt >= 5) return res;
      await sleep(Number(res.headers.get("retry-after") || 1) * 1000);
    }
  };
  const pages = async (path, pick) => {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await call(`${path}${path.includes("?") ? "&" : "?"}limit=${PAGE}&offset=${offset}`);
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
      const body = await res.json();
      const rows = Array.isArray(body) ? body : body.data;
      out.push(...rows.map(pick));
      if (rows.length < PAGE) return out;
    }
  };

  const users = await pages("/users?order_by=%2Bcreated_at", (u) => ({ id: u.id, created_at: u.created_at }));
  const eligible = users.filter((u) => u.created_at < before).map((u) => u.id);
  const members = new Set(await pages(`/organizations/${org}/memberships`, (m) => m.public_user_data?.user_id));
  const counts = { eligible: eligible.length, already_member: 0, added: 0, would_add: 0, failed: 0 };

  for (const id of eligible) {
    if (members.has(id)) { counts.already_member++; continue; }
    if (!apply) { counts.would_add++; continue; }
    const res = await call(`/organizations/${org}/memberships`, { method: "POST", body: JSON.stringify({ user_id: id, role: "org:member" }) });
    if (res.ok) counts.added++;
    else if (res.status === 409 || (await res.text()).includes("already_a_member")) counts.already_member++;
    else { counts.failed++; log(`FAIL ${id} -> ${res.status}`); }
  }
  log(`${apply ? "APPLY" : "DRY RUN"} org=${org} before=${new Date(before).toISOString()} ${JSON.stringify(counts)}`);
  return counts;
}

const argv1 = globalThis.process?.argv?.[1];
if (argv1 && import.meta.url === new URL(`file://${argv1}`).href) {
  run({ env: process.env, apply: process.argv.includes("--apply") }).then(
    (c) => process.exit(c.failed ? 1 : 0),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
