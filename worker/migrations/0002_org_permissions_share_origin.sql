-- 0002: scoped org permissions, org-owned domains, share intent, slug aliases.
-- Additive only: every new column is nullable or defaulted, so existing rows
-- keep their meaning (organization_id NULL = personal asset, share_intent NULL
-- = legacy behaviour). No data is moved or reassigned by this migration.

-- Membership revocation is a tombstone, not a delete, so a stale session token
-- can never re-create a revoked membership through the lazy token sync.
ALTER TABLE organization_memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organization_memberships ADD COLUMN revoked_at TEXT;

-- An org-owned domain is administered by org admins and selectable by members.
ALTER TABLE domains ADD COLUMN organization_id TEXT REFERENCES organizations (id) ON DELETE SET NULL;
ALTER TABLE domains ADD COLUMN is_org_default INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_domains_org_default ON domains (organization_id)
  WHERE is_org_default = 1 AND organization_id IS NOT NULL;

-- Which org (if any) a share was created under, and what the sender chose:
-- 'download' (attachment) or 'host' (inline viewer). NULL intent = legacy.
ALTER TABLE file_assets ADD COLUMN organization_id TEXT REFERENCES organizations (id) ON DELETE SET NULL;
ALTER TABLE file_assets ADD COLUMN share_intent TEXT;
ALTER TABLE link_clicks ADD COLUMN organization_id TEXT REFERENCES organizations (id) ON DELETE SET NULL;
CREATE INDEX idx_file_assets_org ON file_assets (organization_id, created_at);
CREATE INDEX idx_link_clicks_org ON link_clicks (organization_id, created_at);

-- Old slugs keep resolving after an explicit slug change.
CREATE TABLE slug_aliases (
  id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL REFERENCES file_assets (id) ON DELETE CASCADE,
  domain_id TEXT REFERENCES domains (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_slug_aliases_scope ON slug_aliases (COALESCE(domain_id, ''), slug);
CREATE INDEX idx_slug_aliases_file ON slug_aliases (file_id);

-- Delegated read-only reporting. scope 'org' = whole org, 'team' = the reps
-- of leader_user_id (plus the leader). A grant carries no write or secret right.
CREATE TABLE reporting_grants (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'team')),
  leader_user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  granted_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((scope = 'team') = (leader_user_id IS NOT NULL))
);
CREATE INDEX idx_reporting_grants_user ON reporting_grants (organization_id, user_id);
