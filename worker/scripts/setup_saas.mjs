#!/usr/bin/env node
// Cloudflare for SaaS setup for the champbeam.com zone. Dry run by default; --apply writes.
//   node scripts/setup_saas.mjs           show what would change (read-only API calls)
//   node scripts/setup_saas.mjs --apply   create the records and set the fallback origin
// Token: ~/.hermes/secrets/cf-champbeam-token (mode 600). Never printed. Needs, on the zone:
//   Zone:Read, DNS:Edit, SSL and Certificates:Edit (Custom Hostnames).
// Idempotent: existing records are left alone, a mismatching record aborts instead of overwriting.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ZONE_NAME = "champbeam.com";
const ACCOUNT_ID = "ae03bce34fb2cd34756be0003196572f";
const ORIGIN = `origin.${ZONE_NAME}`;
const CNAME = `cname.${ZONE_NAME}`;
const apply = process.argv.includes("--apply");
const API = process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4"; // override is for the mock test

const tokenPath = process.env.CF_TOKEN_FILE ?? join(homedir(), ".hermes/secrets/cf-champbeam-token");
let token;
try {
  if ((statSync(tokenPath).mode & 0o077) !== 0) throw new Error(`${tokenPath} must be mode 600`);
  token = readFileSync(tokenPath, "utf8").trim();
} catch (e) {
  console.error(`BLOCKED: no usable token: ${e.message}`);
  process.exit(2);
}

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.success) {
    const msg = JSON.stringify(j.errors ?? res.status);
    const err = new Error(`${method} ${path}: ${msg}`);
    err.cf = j;
    throw err;
  }
  return j.result;
}

const say = (s) => console.log(apply ? s : `[dry run] ${s}`);

try {
  const zones = await cf("GET", `/zones?name=${ZONE_NAME}`);
  const zone = zones[0];
  if (!zone) throw new Error(`zone ${ZONE_NAME} not visible to this token`);
  if (zone.account?.id !== ACCOUNT_ID) throw new Error(`zone ${ZONE_NAME} is in account ${zone.account?.id}, expected ${ACCOUNT_ID}`);
  console.log(`zone ${ZONE_NAME} ok (${zone.id}), account matches`);

  // Ensure a proxied record exists; refuse to touch one that points elsewhere.
  async function ensure(type, name, content) {
    const found = await cf("GET", `/zones/${zone.id}/dns_records?name=${name}`);
    if (found.length) {
      const r = found[0];
      if (r.type !== type || r.content !== content || !r.proxied) {
        throw new Error(`${name} exists as ${r.type} ${r.content} proxied=${r.proxied}; fix by hand, not overwritten`);
      }
      return say(`${type} ${name} -> ${content} already present`);
    }
    say(`create ${type} ${name} -> ${content} (proxied)`);
    if (apply) await cf("POST", `/zones/${zone.id}/dns_records`, { type, name, content, proxied: true, ttl: 1 });
  }

  await ensure("AAAA", ORIGIN, "100::");

  let current = null;
  try {
    current = await cf("GET", `/zones/${zone.id}/custom_hostnames/fallback_origin`);
  } catch (e) {
    // No fallback origin yet reads as an error; any other failure (token scope, SaaS not enabled) is reported.
    console.log(`fallback origin not set yet (${e.message})`);
  }
  if (current?.origin === ORIGIN) say(`fallback origin already ${ORIGIN} (${current.status})`);
  else {
    say(`set SaaS fallback origin to ${ORIGIN}`);
    if (apply) {
      try {
        await cf("PUT", `/zones/${zone.id}/custom_hostnames/fallback_origin`, { origin: ORIGIN });
      } catch (e) {
        console.error(`BLOCKED: could not set the fallback origin. Cloudflare for SaaS may not be enabled on this zone, or the token lacks SSL and Certificates:Edit. ${e.message}`);
        process.exit(3);
      }
    }
  }

  await ensure("CNAME", CNAME, ORIGIN);

  console.log(`
Set on the champbeam worker (prod only, by the cutover card):
  secret  CLOUDFLARE_API_TOKEN   (a token with SSL and Certificates:Edit on ${ZONE_NAME}; value not printed)
  var     CLOUDFLARE_ZONE_ID=${zone.id}
  var     CLOUDFLARE_CNAME_TARGET=${CNAME}
The worker needs the zone route */* on ${ZONE_NAME} (declared in wrangler.jsonc).`);
  if (!apply) console.log("\nDry run only. Re-run with --apply to write.");
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
