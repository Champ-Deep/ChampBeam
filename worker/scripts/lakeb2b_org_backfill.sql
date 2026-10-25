-- LakeB2B org backfill. NOT a migration: run by hand, once per environment, after
-- clerk_bulk_membership.mjs --apply and after the Clerk webhooks have written the org and
-- membership rows to D1. Re-runnable: every UPDATE only touches rows still unset.
--
-- Placeholders, replaced with sed before wrangler sees the file (D1 has no bind params for --file):
--   :org_id  the CLERK org id (org_...), resolved to organizations.id below
--   :before  ISO UTC cutoff, same instant as the script's BEFORE, e.g. 2026-10-26T00:00:00.000Z
-- If the org row has not synced yet, every statement matches nothing (no writes).
--
-- Content moves only when its owner is a member of the org and existed before the cutoff, so
-- personal content from accounts created after the switch stays personal (organization_id NULL).

UPDATE file_assets SET organization_id = (SELECT id FROM organizations WHERE clerk_org_id = ':org_id')
WHERE organization_id IS NULL
  AND EXISTS (SELECT 1 FROM organizations WHERE clerk_org_id = ':org_id')
  AND user_id IN (SELECT u.id FROM users u
                  JOIN organization_memberships m ON m.user_id = u.id
                  JOIN organizations o ON o.id = m.organization_id AND o.clerk_org_id = ':org_id'
                  WHERE u.created_at < ':before');

UPDATE link_clicks SET organization_id = (SELECT id FROM organizations WHERE clerk_org_id = ':org_id')
WHERE organization_id IS NULL
  AND EXISTS (SELECT 1 FROM organizations WHERE clerk_org_id = ':org_id')
  AND user_id IN (SELECT u.id FROM users u
                  JOIN organization_memberships m ON m.user_id = u.id
                  JOIN organizations o ON o.id = m.organization_id AND o.clerk_org_id = ':org_id'
                  WHERE u.created_at < ':before');

-- idx_domains_org_default allows one default per org, so skip if the org already has one.
UPDATE domains SET organization_id = (SELECT id FROM organizations WHERE clerk_org_id = ':org_id'), is_org_default = 1
WHERE hostname = 'share.lakeb2b.com'
  AND organization_id IS NULL
  AND EXISTS (SELECT 1 FROM organizations WHERE clerk_org_id = ':org_id')
  AND NOT EXISTS (SELECT 1 FROM domains d JOIN organizations o ON o.id = d.organization_id
                  WHERE o.clerk_org_id = ':org_id' AND d.is_org_default = 1);

-- Verification: one row of counts for the org.
SELECT
  (SELECT COUNT(*) FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id WHERE o.clerk_org_id = ':org_id') AS members,
  (SELECT COUNT(*) FROM file_assets f JOIN organizations o ON o.id = f.organization_id WHERE o.clerk_org_id = ':org_id') AS org_files,
  (SELECT COUNT(*) FROM file_assets WHERE organization_id IS NULL) AS personal_files,
  (SELECT COUNT(*) FROM link_clicks l JOIN organizations o ON o.id = l.organization_id WHERE o.clerk_org_id = ':org_id') AS org_links,
  (SELECT COUNT(*) FROM link_clicks WHERE organization_id IS NULL) AS personal_links,
  (SELECT COUNT(*) FROM domains d JOIN organizations o ON o.id = d.organization_id WHERE o.clerk_org_id = ':org_id' AND d.is_org_default = 1) AS org_default_domains;
