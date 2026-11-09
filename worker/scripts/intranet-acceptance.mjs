// BRD section 13: the P0 acceptance checklist, run over HTTP against a running intranet deployment.
//
//   node scripts/intranet-acceptance.mjs --origin http://127.0.0.1:8798 --local [--report ../docs/INTRANET-P0-ACCEPTANCE.md]
//   node scripts/intranet-acceptance.mjs --origin https://champbeam-intranet.<sub>.workers.dev        (remote D1)
//
// It seeds its own org (intranet-bootstrap.mjs semantics) with an Admin, a Reviewer and two Members, all created
// through invite links, then exercises each checklist item through the public API exactly as a browser would.
// Two checks need the database directly (wrangler d1 execute): moving expires_at into the past (REL-3) and proving
// the database itself refuses UPDATE/DELETE on decision_log (7.1). The expiry sweep is triggered through
// /__scheduled when the target is `wrangler dev --test-scheduled`, otherwise the script waits for the cron.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ORIGIN = (arg("origin") || "").replace(/\/+$/, "");
const LOCAL = process.argv.includes("--local");
const REPORT = arg("report");
if (!ORIGIN) {
  console.error("usage: node scripts/intranet-acceptance.mjs --origin <url> [--local] [--report <file.md>]");
  process.exit(2);
}
const worker = fileURLToPath(new URL("..", import.meta.url));
// Run wrangler through node directly: a shell would split SQL arguments on spaces (Windows).
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

function d1(sql, { json = false, allowFail = false } = {}) {
  const args = [WRANGLER, "d1", "execute", "DB", "--env", "intranet", LOCAL ? "--local" : "--remote", "--command", sql];
  if (json) args.push("--json");
  const r = spawnSync(process.execPath, args, { cwd: worker, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`d1 failed: ${r.stdout}\n${r.stderr}`);
  if (allowFail) return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
  return json ? JSON.parse(r.stdout)[0].results : r.stdout;
}

async function http(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (cookie) h.Cookie = cookie;
  let payload = body;
  if (body !== undefined && !(body instanceof Uint8Array)) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const once = () => fetch(`${ORIGIN}${path}`, { method, headers: h, body: payload, redirect: "manual" });
  try {
    return await once();
  } catch (err) {
    // A pooled keep-alive connection the server already closed (the d1/r2 CLI calls pause for seconds): retry once.
    if (err?.cause?.code !== "ECONNRESET") throw err;
    return once();
  }
}
const j = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

// ---------------------------------------------------------------------------
// Setup: org + four people, all through invite links
// ---------------------------------------------------------------------------

const run = randomUUID().slice(0, 8);
const results = [];
function check(id, title, ok, evidence) {
  results.push({ id, title, ok: !!ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${title}\n      ${evidence}`);
}

const now = new Date().toISOString();
const orgId = randomUUID();
d1(`INSERT INTO organizations (id, clerk_org_id, name, slug, created_at, updated_at) VALUES (${q(orgId)}, ${q(randomUUID())}, ${q(`Acceptance ${run}`)}, ${q(`acceptance-${run}`)}, ${q(now)}, ${q(now)})`);
const adminEmail = `admin-${run}@acceptance.test`;
const token = randomBytes(32).toString("base64url");
d1(
  `INSERT INTO org_invites (id, organization_id, email, role, is_reviewer, token_hash, created_at, expires_at)
   VALUES (${q(randomUUID())}, ${q(orgId)}, ${q(adminEmail)}, 'admin', 0, ${q(createHash("sha256").update(token).digest("hex"))}, ${q(now)}, ${q(new Date(Date.now() + 86_400_000).toISOString())})`,
);

async function accept(tok, name) {
  const res = await http("/api/v1/intranet/invites/accept", { method: "POST", body: { token: tok, name, password: `pw-${randomUUID()}` } });
  if (res.status !== 200) throw new Error(`accept ${res.status}: ${await res.text()}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  const me = await j(await http("/api/v1/intranet/me", { cookie }));
  return { cookie, id: me.user.user_id, name };
}

const admin = await accept(token, "Ada Admin");
async function invite(email, isReviewer = false) {
  const res = await http("/api/v1/intranet/invites", { method: "POST", cookie: admin.cookie, body: { email, is_reviewer: isReviewer } });
  if (res.status !== 201) throw new Error(`invite ${res.status}: ${await res.text()}`);
  return (await j(res)).token;
}
const reviewer = await accept(await invite(`reviewer-${run}@acceptance.test`, true), "Rita Reviewer");
const alice = await accept(await invite(`alice-${run}@acceptance.test`), "Alice");
const bob = await accept(await invite(`bob-${run}@acceptance.test`), "Bob");
console.log(`org ${orgId}: admin, reviewer, alice, bob signed up through invites\n`);

async function submit(from, to, { oneTime = false, content = `acceptance ${randomUUID()}` } = {}) {
  const bytes = new TextEncoder().encode(content);
  const init = await j(await http("/api/v1/intranet/uploads", { method: "POST", cookie: from.cookie, body: { filename: "data.csv", content_type: "text/csv", size_bytes: bytes.length } }));
  const put = await fetch(init.upload_url.startsWith("http") ? init.upload_url : `${ORIGIN}${init.upload_url}`, { method: "PUT", body: bytes, headers: init.headers });
  if (put.status >= 300) throw new Error(`blob ${put.status}`);
  const res = await http("/api/v1/intranet/transfers", {
    method: "POST",
    cookie: from.cookie,
    body: { file_id: init.file_id, recipient_user_id: to.id, purpose: "Acceptance test data drop", requested_one_time: oneTime },
  });
  if (res.status !== 201) throw new Error(`submit ${res.status}: ${await res.text()}`);
  return { t: await j(res), content };
}
const approve = (who, id, body = {}) => http(`/api/v1/intranet/review/${id}/approve`, { method: "POST", cookie: who.cookie, body });
const download = (who, id) => http(`/api/v1/intranet/transfers/${id}/download`, { cookie: who?.cookie });
const events = (id) => d1(`SELECT event FROM decision_log WHERE transfer_id = ${q(id)} ORDER BY id`, { json: true }).map((r) => r.event);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ok, ms = 10_000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(250);
    v = await fn();
  }
  return v;
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

// 1. ACC-3
{
  const email = `stranger-${run}@acceptance.test`;
  const signUp = await http("/api/auth/sign-up/email", { method: "POST", body: { email, password: "a-long-password-1", name: "Stranger" } });
  const fake = await http("/api/v1/intranet/invites/accept", { method: "POST", body: { token: randomBytes(32).toString("base64url"), name: "S", password: "a-long-password-1" } });
  const signIn = await http("/api/auth/sign-in/email", { method: "POST", body: { email, password: "a-long-password-1" } });
  const anon = await http("/api/v1/intranet/me");
  const row = d1(`SELECT COUNT(*) AS n FROM users WHERE email = ${q(email)}`, { json: true })[0].n;
  check("ACC-3", "An email that was never invited cannot sign up or call any route", signUp.status === 404 && fake.status === 404 && signIn.status >= 400 && anon.status === 401 && row === 0,
    `sign-up ${signUp.status}, invite-accept with a made-up token ${fake.status}, sign-in ${signIn.status}, /intranet/me without a session ${anon.status}, users rows for that email: ${row}`);
}

// 2. SUB-2
const a = await submit(alice, bob);
{
  const toBob = await download(bob, a.t.id);
  const toAdmin = await download(admin, a.t.id);
  const toReviewer = await download(reviewer, a.t.id);
  const inbox = await j(await http("/api/v1/intranet/inbox", { cookie: bob.cookie }));
  check("SUB-2", "An unapproved file returns 403 to the recipient, and to every other member", toBob.status === 403 && toAdmin.status === 403 && toReviewer.status === 403 && inbox.length === 0,
    `recipient ${toBob.status}, admin ${toAdmin.status}, reviewer via the recipient route ${toReviewer.status}, recipient inbox ${inbox.length} items`);
}

// 3. NFR-1
{
  await approve(reviewer, a.t.id);
  const paths = [`/api/v1/intranet/transfers/${a.t.id}/download`, `/api/v1/intranet/review/${a.t.id}/file`, `/api/v1/intranet/transfers/${a.t.id}`, "/api/v1/intranet/log.csv", `/api/v1/intranet/download/${Buffer.from(`transfer.${a.t.id}.${bob.id}.${orgId}.9999999999.forged`).toString("base64url")}`, `/f/abc`, `/r/abc`];
  const statuses = [];
  let leaked = false;
  for (const p of paths) {
    const res = await http(p, { headers: { Origin: "" } });
    const body = await res.text();
    statuses.push(`${p.replace(a.t.id, "{id}").slice(0, 60)} -> ${res.status}`);
    if (body.includes(a.content) || res.headers.get("content-disposition")) leaked = true;
    if (p.startsWith("/api") && ![401, 404].includes(res.status)) leaked = true;
  }
  check("NFR-1", "An unauthenticated request to any file path returns 401 or 404, never bytes", !leaked, statuses.join("; "));
}

// 4. REV-4
{
  const own = await submit(reviewer, alice);
  const res = await approve(reviewer, own.t.id);
  const rej = await http(`/api/v1/intranet/review/${own.t.id}/reject`, { method: "POST", cookie: reviewer.cookie, body: { reason: "x" } });
  check("REV-4", "A Reviewer cannot approve their own submission", res.status === 403 && rej.status === 403, `approve own ${res.status} (${(await j(res)).detail}); reject own ${rej.status}`);
}

// 5. REL-4
{
  const o = await submit(alice, bob, { oneTime: true });
  await approve(reviewer, o.t.id);
  const all = await Promise.all(Array.from({ length: 10 }, () => download(bob, o.t.id)));
  const bodies = await Promise.all(all.map((r) => r.text()));
  const ok = all.filter((r) => r.status === 200);
  const winnerBody = bodies[all.findIndex((r) => r.status === 200)];
  const state = await until(() => d1(`SELECT state FROM transfers WHERE id = ${q(o.t.id)}`, { json: true })[0].state, (s) => s === "consumed");
  const after = await download(bob, o.t.id);
  check("REL-4", "Ten parallel downloads of a one-time file yield exactly one success", ok.length === 1 && winnerBody === o.content && state === "consumed" && after.status === 410,
    `statuses ${all.map((r) => r.status).join(",")}; winner got the exact bytes: ${winnerBody === o.content}; state ${state}; an 11th try ${after.status}`);
}

// 6. REL-3
{
  const e = await submit(alice, bob);
  await approve(reviewer, e.t.id, { expires_in_days: 1 });
  const key = d1(`SELECT f.storage_key FROM transfers t JOIN file_assets f ON f.id = t.file_id WHERE t.id = ${q(e.t.id)}`, { json: true })[0].storage_key;
  d1(`UPDATE transfers SET expires_at = ${q(new Date(Date.now() - 1000).toISOString())} WHERE id = ${q(e.t.id)}`);
  const refused = await download(bob, e.t.id);
  let swept;
  const sched = await fetch(`${ORIGIN}/__scheduled?cron=*/5+*+*+*+*`).catch(() => null);
  if (sched && sched.status === 200) swept = d1(`SELECT state FROM transfers WHERE id = ${q(e.t.id)}`, { json: true })[0].state;
  else swept = await until(() => d1(`SELECT state FROM transfers WHERE id = ${q(e.t.id)}`, { json: true })[0].state, (s) => s === "expired", 6 * 60_000);
  const fileStatus = d1(`SELECT f.status FROM transfers t JOIN file_assets f ON f.id = t.file_id WHERE t.id = ${q(e.t.id)}`, { json: true })[0].status;
  const blob = spawnSync(process.execPath, [WRANGLER, "r2", "object", "get", `champbeam-intranet-files/${key}`, "--env", "intranet", LOCAL ? "--local" : "--remote", "--pipe"], { cwd: worker, encoding: "utf8" });
  const blobGone = blob.status !== 0;
  check("REL-3", "After expires_at the file is refused and the blob is gone after the sweep", refused.status === 410 && swept === "expired" && fileStatus === "deleted" && blobGone,
    `download after expiry ${refused.status}; after the sweep: transfer ${swept}, file row ${fileStatus}, R2 object ${blobGone ? "not found" : "STILL PRESENT"}`);
}

// 7. REL-5
{
  const r = await submit(alice, bob);
  await approve(reviewer, r.t.id);
  const before = await download(bob, r.t.id);
  await before.text();
  const rv = await http(`/api/v1/intranet/transfers/${r.t.id}/revoke`, { method: "POST", cookie: alice.cookie, body: { reason: "wrong file" } });
  const after = await download(bob, r.t.id);
  check("REL-5", "A revoked file is refused at once", before.status === 200 && rv.status === 200 && after.status === 410, `download before ${before.status}, revoke ${rv.status}, download right after ${after.status} (${(await j(after)).detail})`);
}

// 8. REV-3
{
  const x = await submit(alice, bob);
  const tries = [];
  for (const body of [{}, { reason: "" }, { reason: "   " }]) tries.push((await http(`/api/v1/intranet/review/${x.t.id}/reject`, { method: "POST", cookie: reviewer.cookie, body })).status);
  const ok = await http(`/api/v1/intranet/review/${x.t.id}/reject`, { method: "POST", cookie: reviewer.cookie, body: { reason: "Contains customer PII" } });
  const mine = await j(await http("/api/v1/intranet/transfers/mine", { cookie: alice.cookie }));
  const shown = mine.find((t) => t.id === x.t.id)?.reject_reason;
  check("REV-3", "Reject without a reason is refused", tries.every((s) => s === 422) && ok.status === 200 && shown === "Contains customer PII",
    `no reason / empty / blank -> ${tries.join(", ")}; with a reason ${ok.status}; the submitter sees "${shown}"`);
}

// 9. REL-6
{
  const r = await submit(alice, bob);
  await approve(reviewer, r.t.id);
  const receipt = async () => (await j(await http("/api/v1/intranet/transfers/mine", { cookie: alice.cookie }))).find((t) => t.id === r.t.id);
  const before = await receipt();
  await (await download(bob, r.t.id)).text();
  const after = await until(receipt, (t) => t.receipt === "opened");
  check("REL-6", "The submitter sees Not opened, then Opened with a time", before.receipt === "not_opened" && after.receipt === "opened" && !!after.first_opened_at,
    `before: ${before.receipt}; after the recipient's download: ${after.receipt} at ${after.first_opened_at}`);
}

// 10. 7.1 (last, so it covers every state change above)
{
  const transfers = d1(`SELECT id, state FROM transfers WHERE organization_id = ${q(orgId)}`, { json: true });
  const missing = [];
  const expected = { released: ["submitted", "approved", "released"], consumed: ["approved", "released", "opened_by_recipient", "consumed"], expired: ["released", "expired"], revoked: ["released", "revoked"], rejected: ["submitted", "rejected"], submitted: ["submitted"] };
  for (const t of transfers) {
    const ev = events(t.id);
    for (const need of expected[t.state] ?? ["submitted"]) if (!ev.includes(need)) missing.push(`${t.state}:${need}`);
  }
  const verify = await j(await http("/api/v1/intranet/log/verify", { cookie: reviewer.cookie }));
  const upd = d1(`UPDATE decision_log SET reason = 'tampered' WHERE organization_id = ${q(orgId)}`, { allowFail: true });
  const del = d1(`DELETE FROM decision_log WHERE organization_id = ${q(orgId)}`, { allowFail: true });
  const routes = [];
  for (const m of ["PUT", "PATCH", "DELETE", "POST"]) routes.push((await http("/api/v1/intranet/log", { method: m, cookie: admin.cookie, body: {} })).status);
  const firstId = (await j(await http("/api/v1/intranet/log?limit=1", { cookie: admin.cookie }))).items[0].id;
  for (const m of ["PUT", "PATCH", "DELETE"]) routes.push((await http(`/api/v1/intranet/log/${firstId}`, { method: m, cookie: admin.cookie, body: {} })).status);
  const total = d1(`SELECT COUNT(*) AS n FROM decision_log WHERE organization_id = ${q(orgId)}`, { json: true })[0].n;
  check("7.1", "Every state change produced a decision-log row, and no API route can edit or delete one",
    !missing.length && verify.ok && !upd.ok && /append-only/.test(upd.out) && !del.ok && /append-only/.test(del.out) && routes.every((s) => s === 404 || s === 405),
    `${transfers.length} transfers, ${total} log rows, missing events: ${missing.length ? missing.join(", ") : "none"}; hash chain verify ok=${verify.ok} over ${verify.rows} rows; ` +
      `direct SQL UPDATE refused: ${!upd.ok}, DELETE refused: ${!del.ok} (trigger: decision_log is append-only); write methods on /log and /log/{id}: ${routes.join(",")}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (REPORT) {
  const lines = [
    "# Intranet P0 acceptance run (BRD section 13)",
    "",
    `- Target: \`${ORIGIN}\` (${LOCAL ? "local `wrangler dev --env intranet`, local D1 and R2" : "Cloudflare, remote D1 and R2"})`,
    `- Run: ${new Date().toISOString()}, org \`${orgId}\``,
    `- Script: \`worker/scripts/intranet-acceptance.mjs\`. Every person was created through an invite link; every step went through the HTTP API.`,
    `- Result: **${passed}/${results.length} passed**`,
    "",
    "| # | BRD | Check | Result | Evidence |",
    "|---|---|---|---|---|",
    ...results.map((r, i) => `| ${i + 1} | ${r.id} | ${r.title} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.evidence.replace(/\|/g, "\\|")} |`),
    "",
  ];
  writeFileSync(REPORT, lines.join("\n"));
  console.log(`report written to ${REPORT}`);
}
process.exit(passed === results.length ? 0 : 1);
