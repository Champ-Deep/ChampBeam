/**
 * Org-domain adoption: move an org's existing content (domain_id NULL, the platform bucket) onto
 * the org's domain so every old URL resolves there. lookupAsset / findLink serve an org domain
 * ONLY rows whose domain_id equals it, so without this an org domain 404s all pre-existing links.
 *
 * Step 1 attaches members' unowned content (organization_id NULL) to the org; this is the port of
 * scripts/lakeb2b_org_backfill.sql, keyed by the local org id. Step 2 sets domain_id, NULLs only,
 * skipping rows whose (domain_id, short_code) or (domain_id, slug) is already taken on the target.
 * Skipped rows are reported, never overwritten. Re-running changes nothing new.
 *
 * Exports:
 *   adoptExisting(d1, orgId, domainId, { dryRun, before? }) -> Promise<AdoptionReport>
 *   adoptIfOrgDefault(d1, domainRow)                        -> Promise<AdoptionReport | null>
 */
import type { DomainRow } from "./domainProvisioning";

export interface AdoptionReport {
  dry_run: boolean;
  attached: { files: number; links: number };
  adopted: { files: number; links: number; aliases: number };
  collisions: {
    files: { short_code: string; slug: string | null }[];
    links: { short_code: string }[];
    aliases: { slug: string }[];
  };
}

const LIST_CAP = 200;

// ?1 org, ?2 target domain, ?3 user-created-before cutoff. A statement binds only the params it uses.
const ORG_SCOPE = `(organization_id = ?1 OR (organization_id IS NULL AND user_id IN (
  SELECT m.user_id FROM organization_memberships m JOIN users u ON u.id = m.user_id
  WHERE m.organization_id = ?1 AND m.status = 'active' AND u.created_at < ?3)))`;
const UNOWNED = `organization_id IS NULL AND user_id IN (
  SELECT m.user_id FROM organization_memberships m JOIN users u ON u.id = m.user_id
  WHERE m.organization_id = ?1 AND m.status = 'active' AND u.created_at < ?3)`;
// Mirrors the unique indexes: short_code per domain; slug per domain ignoring deleted rows.
const FILE_FREE = `NOT EXISTS (SELECT 1 FROM file_assets x WHERE x.domain_id = ?2 AND x.short_code = file_assets.short_code)
  AND (slug IS NULL OR status = 'deleted' OR NOT EXISTS
    (SELECT 1 FROM file_assets x WHERE x.domain_id = ?2 AND x.slug = file_assets.slug AND x.status <> 'deleted'))`;
const LINK_FREE = `(short_code IS NULL OR NOT EXISTS
  (SELECT 1 FROM link_clicks x WHERE x.domain_id = ?2 AND x.short_code = link_clicks.short_code))`;
const ALIAS_WHERE = `domain_id IS NULL
  AND file_id IN (SELECT id FROM file_assets WHERE (domain_id IS NULL AND ${ORG_SCOPE} AND ${FILE_FREE}) OR domain_id = ?2)
  AND NOT EXISTS (SELECT 1 FROM slug_aliases x WHERE x.domain_id = ?2 AND x.slug = slug_aliases.slug)`;

export async function adoptExisting(
  d1: D1Database,
  orgId: string,
  domainId: string,
  opts: { dryRun: boolean; before?: string | null }, // before: override, default = org created_at
): Promise<AdoptionReport> {
  // Personal space is a promise: without an explicit cutoff, only accounts older than the org move.
  const cutoff =
    opts.before ||
    (await d1.prepare("SELECT created_at c FROM organizations WHERE id = ?1").bind(orgId).first<{ c: string }>())?.c ||
    "0000-01-01T00:00:00.000Z"; // unknown org: attach nothing
  const args = [orgId, domainId, cutoff];
  const st = (sql: string) => d1.prepare(sql).bind(...args.slice(0, Math.max(...[...sql.matchAll(/\?(\d)/g)].map((m) => +m[1]))));
  const count = async (sql: string) => (await st(sql).first<{ n: number }>())?.n ?? 0;

  const fileWhere = `domain_id IS NULL AND ${ORG_SCOPE} AND ${FILE_FREE}`;
  const linkWhere = `domain_id IS NULL AND ${ORG_SCOPE} AND ${LINK_FREE}`;

  let attached, adopted;
  if (opts.dryRun) {
    attached = {
      files: await count(`SELECT COUNT(*) n FROM file_assets WHERE ${UNOWNED}`),
      links: await count(`SELECT COUNT(*) n FROM link_clicks WHERE ${UNOWNED}`),
    };
    adopted = {
      files: await count(`SELECT COUNT(*) n FROM file_assets WHERE ${fileWhere}`),
      links: await count(`SELECT COUNT(*) n FROM link_clicks WHERE ${linkWhere}`),
      aliases: await count(`SELECT COUNT(*) n FROM slug_aliases WHERE ${ALIAS_WHERE}`),
    };
  } else {
    const r = await d1.batch([
      st(`UPDATE file_assets SET organization_id = ?1 WHERE ${UNOWNED}`),
      st(`UPDATE link_clicks SET organization_id = ?1 WHERE ${UNOWNED}`),
      st(`UPDATE file_assets SET domain_id = ?2 WHERE ${fileWhere}`),
      st(`UPDATE link_clicks SET domain_id = ?2 WHERE ${linkWhere}`),
      st(`UPDATE slug_aliases SET domain_id = ?2 WHERE ${ALIAS_WHERE}`),
    ]);
    const ch = r.map((x) => x.meta.changes ?? 0);
    attached = { files: ch[0], links: ch[1] };
    adopted = { files: ch[2], links: ch[3], aliases: ch[4] };
  }

  // After apply, whatever in scope still has domain_id NULL is exactly what was skipped.
  const files = await st(
    `SELECT short_code, slug FROM file_assets WHERE domain_id IS NULL AND ${ORG_SCOPE} AND NOT (${FILE_FREE}) LIMIT ${LIST_CAP}`,
  ).all<{ short_code: string; slug: string | null }>();
  const links = await st(
    `SELECT short_code FROM link_clicks WHERE domain_id IS NULL AND ${ORG_SCOPE} AND NOT ${LINK_FREE} LIMIT ${LIST_CAP}`,
  ).all<{ short_code: string }>();
  const aliases = await st(
    `SELECT slug FROM slug_aliases WHERE domain_id IS NULL AND EXISTS (SELECT 1 FROM slug_aliases x WHERE x.domain_id = ?2 AND x.slug = slug_aliases.slug)
       AND file_id IN (SELECT id FROM file_assets WHERE ${ORG_SCOPE}) LIMIT ${LIST_CAP}`,
  ).all<{ slug: string }>();

  return {
    dry_run: opts.dryRun,
    attached,
    adopted,
    collisions: { files: files.results, links: links.results, aliases: aliases.results },
  };
}

/** Activation hook: an active org default domain adopts the org's existing content. */
export async function adoptIfOrgDefault(d1: D1Database, d: DomainRow): Promise<AdoptionReport | null> {
  if (!d.organizationId || !d.isOrgDefault || d.status !== "active") return null;
  return adoptExisting(d1, d.organizationId, d.id, { dryRun: false });
}
