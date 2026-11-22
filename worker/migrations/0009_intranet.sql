-- ChampBeam Intranet (BRD v1.0, P0 to P2) on D1. Port of backend/alembic/versions/031-033.
-- Additive: the marketing tables are untouched. Only an intranet deployment (INTRANET_MODE=true) uses these.

-- Reviewer is an app-managed flag; admin comes from organization_memberships.role.
ALTER TABLE organization_memberships ADD COLUMN is_reviewer INTEGER NOT NULL DEFAULT 0;
-- ACC-4: a deactivated member loses access on the next request; their history stays.
ALTER TABLE organization_memberships ADD COLUMN deactivated_at TEXT;

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
  submitter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted',
  requested_expires_in_days INTEGER,
  requested_one_time INTEGER NOT NULL DEFAULT 0,
  one_time INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  download_claim_token TEXT,
  download_claim_at TEXT,
  check_results TEXT,
  submitted_at TEXT NOT NULL,
  agent_window_ends_at TEXT,
  hard_expires_at TEXT,
  decided_at TEXT,
  decided_by_type TEXT,
  decided_by_id TEXT,
  reject_reason TEXT,
  released_at TEXT,
  first_opened_at TEXT,
  consumed_at TEXT,
  expired_at TEXT,
  revoked_at TEXT,
  revoked_by_id TEXT,
  withdrawn_at TEXT,
  -- P1: malware scan, reminders, review agent
  scan_status TEXT,
  scan_detail TEXT,
  scanned_at TEXT,
  reminded_at TEXT,
  escalated_at TEXT,
  escalation_reason TEXT,
  agent_evaluated_at TEXT,
  agent_result TEXT,
  -- P2: access code on release, attempts counted per file (no Redis)
  access_code_hash TEXT,
  access_code_attempts INTEGER NOT NULL DEFAULT 0,
  access_code_window_at TEXT
);
-- One transfer per upload.
CREATE UNIQUE INDEX IF NOT EXISTS ux_transfers_file_id ON transfers (file_id);
CREATE INDEX IF NOT EXISTS ix_transfers_org_state ON transfers (organization_id, state, submitted_at);
CREATE INDEX IF NOT EXISTS ix_transfers_submitter ON transfers (submitter_user_id, submitted_at);
CREATE INDEX IF NOT EXISTS ix_transfers_recipient ON transfers (recipient_user_id, released_at);
CREATE INDEX IF NOT EXISTS ix_transfers_expires_at ON transfers (state, expires_at);
CREATE INDEX IF NOT EXISTS ix_transfers_hard_expires_at ON transfers (state, hard_expires_at);

-- Append-only, hash-chained decision log (BRD 7.1). No foreign keys: rows outlive the blob, the
-- transfer and the org. The unique (org, prev_hash) index makes the chain linear: two writers that
-- read the same tip cannot both append, the loser retries on the new tip.
CREATE TABLE IF NOT EXISTS decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  transfer_id TEXT,
  event TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  detail TEXT,
  agent_provider TEXT,
  agent_model TEXT,
  agent_input_mode TEXT,
  agent_p_approve REAL,
  agent_threshold REAL,
  agent_input_sha256 TEXT,
  prev_hash TEXT,
  row_hash TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_log_chain ON decision_log (organization_id, COALESCE(prev_hash, ''));
CREATE INDEX IF NOT EXISTS ix_decision_log_org_at ON decision_log (organization_id, at);
CREATE INDEX IF NOT EXISTS ix_decision_log_transfer ON decision_log (transfer_id);
CREATE INDEX IF NOT EXISTS ix_decision_log_actor ON decision_log (organization_id, actor_id);
CREATE INDEX IF NOT EXISTS ix_decision_log_event ON decision_log (organization_id, event);

-- The database itself refuses edits and deletes, whatever the application does.
CREATE TRIGGER IF NOT EXISTS decision_log_no_update BEFORE UPDATE ON decision_log
BEGIN
  SELECT RAISE(ABORT, 'decision_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS decision_log_no_delete BEFORE DELETE ON decision_log
BEGIN
  SELECT RAISE(ABORT, 'decision_log is append-only');
END;

CREATE TABLE IF NOT EXISTS org_review_settings (
  organization_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_mode TEXT NOT NULL DEFAULT 'off',
  agent_window_hours INTEGER NOT NULL DEFAULT 24,
  agent_threshold REAL NOT NULL DEFAULT 0.95,
  agent_input_mode TEXT NOT NULL DEFAULT 'metadata_only',
  default_expiry_days INTEGER NOT NULL DEFAULT 7,
  hard_expiry_days INTEGER NOT NULL DEFAULT 7,
  reminder_hours INTEGER DEFAULT 12,
  updated_at TEXT,
  updated_by_id TEXT
);

-- Invite-only sign-up (ACC-1 to ACC-3). The raw token is shown to the inviting Admin once; only its
-- SHA-256 is stored. accepted_at is set when the invitee creates their account.
CREATE TABLE IF NOT EXISTS org_invites (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_reviewer INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL,
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_org_invites_org ON org_invites (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_org_invites_email ON org_invites (email);
CREATE UNIQUE INDEX IF NOT EXISTS ux_org_invites_token ON org_invites (token_hash);

CREATE TABLE IF NOT EXISTS agent_benchmarks (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  finished_at TEXT,
  created_by_id TEXT,
  report TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_agent_benchmarks_org ON agent_benchmarks (organization_id, created_at);
