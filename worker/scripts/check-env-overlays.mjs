// Overlay isolation gate for wrangler.jsonc. `--deployable` additionally rejects TODO_ placeholders.
// shortcut: strips only whole-line // comments, so keep comments on their own lines in wrangler.jsonc.
import { readFileSync } from "node:fs";
const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const cfg = JSON.parse(raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
const errs = [];
const prod = { d1: cfg.d1_databases[0].database_name, r2: cfg.r2_buckets[0].bucket_name };
const seen = new Set();
for (const [name, e] of Object.entries(cfg.env ?? {})) {
  if (!e.d1_databases?.length || !e.r2_buckets?.length || !e.vars) errs.push(`${name}: bindings/vars are not inherited, declare d1, r2 and vars`);
  const d1 = e.d1_databases?.[0]?.database_name, r2 = e.r2_buckets?.[0]?.bucket_name;
  if (d1 === prod.d1 || r2 === prod.r2) errs.push(`${name}: shares production D1/R2`);
  for (const k of [d1, r2]) { if (seen.has(k)) errs.push(`${name}: ${k} reused by another env`); seen.add(k); }
  if (e.vars?.ENVIRONMENT !== name) errs.push(`${name}: vars.ENVIRONMENT must equal the env name`);
  if (process.argv.includes("--deployable") && /TODO_/.test(JSON.stringify(e))) errs.push(`${name}: unresolved TODO_ placeholder`);
}
console.log(errs.length ? errs.map((x) => "FAIL " + x).join("\n") : "OK");
process.exit(errs.length ? 1 : 0);
