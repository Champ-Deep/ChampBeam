-- A1 forward alerts: one row per detected forward of a link or file, for the asset owner only.
-- No IP, user agent or email is stored here.
CREATE TABLE IF NOT EXISTS forward_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('link', 'file')),
  asset_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('cities', 'new_company')),
  dedupe_key TEXT NOT NULL,
  cities TEXT NOT NULL DEFAULT '[]',
  visitor_ids TEXT NOT NULL DEFAULT '[]',
  company_name TEXT,
  company_domain TEXT,
  evidence_event_id TEXT,
  detected_at TEXT NOT NULL,
  seen_at TEXT,
  dismissed_at TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  draft_model TEXT,
  draft_created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_forward_alerts_asset_key ON forward_alerts (asset_type, asset_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_forward_alerts_user_open ON forward_alerts (user_id, dismissed_at, detected_at DESC);
