-- Self-serve orgs. Additive only. Indexes the new queries rely on already exist:
--   memberships by user  -> idx_org_memberships_user (0001)
--   invitations by email -> invitation_email_idx (0007)
--   domains by hostname  -> idx_domains_hostname, unique (0001)
--   orgs by slug         -> organizations_slug_uidx (0007)

-- share.lakeb2b.com legacy serving: when set, the domain also serves platform-bucket
-- (domain_id IS NULL) content created before this ISO-8601 UTC instant, whatever org owns it.
ALTER TABLE domains ADD COLUMN legacy_platform_before TEXT;

-- One row per super-admin action.
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  payload TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_admin_audit_at ON admin_audit (at);
