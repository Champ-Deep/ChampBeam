-- Company email domains an org auto-joins on verified sign-in (t_b2ddf964). Additive and idempotent;
-- seeded empty, an org admin adds domains in Settings. One email domain belongs to at most one org.
CREATE TABLE IF NOT EXISTS org_email_domains (
  domain TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_email_domains_org ON org_email_domains (organization_id);

-- Once-per-user marker: the sign-in join runs at most once, so removing a member (which deletes the row) sticks.
-- Backfilled for everyone who exists today: they were all joined by the earlier join-everyone rule or removed on purpose.
ALTER TABLE users ADD COLUMN org_join_checked_at TEXT;
UPDATE users SET org_join_checked_at = datetime('now') WHERE org_join_checked_at IS NULL;
