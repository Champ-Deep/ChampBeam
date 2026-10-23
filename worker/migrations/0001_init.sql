-- ChampBeam D1 (SQLite) schema.
--
-- A one-shot translation of the 28 Alembic (Postgres) migrations in
-- backend/alembic/versions to their end state. Type mapping:
--   UUID            -> TEXT (canonical lowercase 8-4-4-4-12 string)
--   TIMESTAMP       -> TEXT, ISO-8601 UTC "YYYY-MM-DDTHH:MM:SS.sssZ" (sorts and
--                      compares correctly as text; see src/lib/time.ts)
--   DATE            -> TEXT "YYYY-MM-DD"
--   BOOLEAN         -> INTEGER 0/1
--   JSON / JSONB    -> TEXT holding JSON (query with json_extract & co.)
--   BIGINT / FLOAT  -> INTEGER / REAL
-- Partial unique indexes carry over unchanged (SQLite supports them).

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  clerk_id TEXT,
  email TEXT NOT NULL,
  hashed_password TEXT,
  full_name TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  last_login TEXT
);
CREATE UNIQUE INDEX ix_users_email ON users (email);
CREATE UNIQUE INDEX ix_users_clerk_id ON users (clerk_id);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  clerk_org_id TEXT NOT NULL,
  name TEXT,
  slug TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX idx_organizations_clerk_org_id ON organizations (clerk_org_id);
CREATE INDEX idx_organizations_slug ON organizations (slug);

CREATE TABLE organization_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  clerk_membership_id TEXT,
  leader_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX uq_org_membership_org_user ON organization_memberships (organization_id, user_id);
CREATE INDEX idx_org_memberships_org ON organization_memberships (organization_id);
CREATE INDEX idx_org_memberships_user ON organization_memberships (user_id);
CREATE INDEX idx_org_memberships_clerk ON organization_memberships (clerk_membership_id);
CREATE INDEX idx_org_memberships_leader ON organization_memberships (leader_user_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX idx_api_keys_user ON api_keys (user_id);

CREATE TABLE utm_presets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  is_shared INTEGER DEFAULT 0,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  custom_params TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_utm_presets_user_id ON utm_presets (user_id);
CREATE INDEX idx_utm_presets_user_id_is_default ON utm_presets (user_id, is_default);

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_projects_user_id ON projects (user_id);

CREATE TABLE domains (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_cname',
  cf_custom_hostname_id TEXT,
  ssl_status TEXT,
  verification_errors TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  last_checked_at TEXT,
  provision_requested_at TEXT,
  provision_attempts INTEGER NOT NULL DEFAULT 0,
  registrar TEXT,
  registration_status TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  registration_price TEXT,
  domain_expires_at TEXT
);
CREATE UNIQUE INDEX idx_domains_hostname ON domains (hostname);
CREATE INDEX idx_domains_user_id ON domains (user_id);
CREATE INDEX idx_domains_status ON domains (status);
CREATE UNIQUE INDEX idx_domains_user_primary ON domains (user_id) WHERE is_primary = 1;

CREATE TABLE link_clicks (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  domain_id TEXT REFERENCES domains (id) ON DELETE SET NULL,
  short_code TEXT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  project_name TEXT,
  original_url TEXT NOT NULL,
  tracked_url TEXT,
  anchor_text TEXT,
  link_position INTEGER,
  champvault_asset_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  click_count INTEGER DEFAULT 0,
  unique_clicks INTEGER DEFAULT 0,
  first_clicked_at TEXT,
  last_clicked_at TEXT,
  expires_at TEXT,
  max_views INTEGER,
  revoked_at TEXT,
  require_email INTEGER NOT NULL DEFAULT 0,
  block_vpn INTEGER NOT NULL DEFAULT 0,
  branded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);
CREATE INDEX idx_link_clicks_user_id ON link_clicks (user_id);
CREATE INDEX idx_link_clicks_user_id_created_at ON link_clicks (user_id, created_at);
CREATE INDEX idx_link_clicks_utm_source ON link_clicks (utm_source);
CREATE INDEX idx_link_clicks_utm_campaign ON link_clicks (utm_campaign);
CREATE INDEX idx_link_clicks_project_name ON link_clicks (project_name);
CREATE INDEX idx_link_clicks_project_id ON link_clicks (project_id);
CREATE INDEX idx_link_clicks_user_campaign ON link_clicks (user_id, utm_campaign);
CREATE INDEX idx_link_clicks_domain_id ON link_clicks (domain_id);
CREATE INDEX idx_link_clicks_short_code ON link_clicks (short_code);
CREATE INDEX idx_link_clicks_expires_at ON link_clicks (expires_at);
CREATE INDEX idx_link_clicks_champvault_asset ON link_clicks (champvault_asset_id);
CREATE UNIQUE INDEX idx_link_clicks_short_code_per_domain ON link_clicks (domain_id, short_code)
  WHERE domain_id IS NOT NULL AND short_code IS NOT NULL;
CREATE UNIQUE INDEX idx_link_clicks_short_code_global ON link_clicks (short_code)
  WHERE domain_id IS NULL AND short_code IS NOT NULL;

CREATE TABLE file_assets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  domain_id TEXT REFERENCES domains (id) ON DELETE SET NULL,
  short_code TEXT NOT NULL,
  slug TEXT,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  storage_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_upload',
  serve_mode TEXT NOT NULL DEFAULT 'stream',
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  max_views INTEGER,
  revoked_at TEXT,
  require_email INTEGER NOT NULL DEFAULT 0,
  block_vpn INTEGER NOT NULL DEFAULT 0,
  branded INTEGER NOT NULL DEFAULT 0,
  owner_token_hash TEXT,
  state_token TEXT,
  access_code_hash TEXT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL
);
CREATE INDEX idx_file_assets_user_id ON file_assets (user_id);
CREATE INDEX idx_file_assets_domain_id ON file_assets (domain_id);
CREATE INDEX idx_file_assets_short_code ON file_assets (short_code);
CREATE INDEX idx_file_assets_status ON file_assets (status);
CREATE INDEX idx_file_assets_user_id_created_at ON file_assets (user_id, created_at DESC);
CREATE INDEX idx_file_assets_expires_at ON file_assets (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_file_assets_project_id ON file_assets (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX ix_file_assets_slug ON file_assets (slug);
CREATE UNIQUE INDEX idx_file_assets_short_code_per_domain ON file_assets (domain_id, short_code)
  WHERE domain_id IS NOT NULL;
CREATE UNIQUE INDEX idx_file_assets_short_code_global ON file_assets (short_code)
  WHERE domain_id IS NULL;
CREATE UNIQUE INDEX idx_file_assets_slug_per_domain ON file_assets (domain_id, slug)
  WHERE domain_id IS NOT NULL AND slug IS NOT NULL;
CREATE UNIQUE INDEX idx_file_assets_slug_global ON file_assets (slug)
  WHERE domain_id IS NULL AND slug IS NOT NULL;

CREATE TABLE file_versions (
  id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL REFERENCES file_assets (id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_file_versions_file_id ON file_versions (file_id);
CREATE UNIQUE INDEX uq_file_versions_file_no ON file_versions (file_id, version_no);

CREATE TABLE click_events (
  id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT REFERENCES link_clicks (id) ON DELETE CASCADE,
  file_id TEXT REFERENCES file_assets (id) ON DELETE CASCADE,
  domain_id TEXT REFERENCES domains (id) ON DELETE SET NULL,
  visitor_id TEXT,
  is_revisit INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  is_vpn INTEGER NOT NULL DEFAULT 0,
  asn_org TEXT,
  company_name TEXT,
  company_domain TEXT,
  company_industry TEXT,
  company_size TEXT,
  company_type TEXT,
  clicked_at TEXT NOT NULL
);
CREATE INDEX idx_click_events_link_id ON click_events (link_id);
CREATE INDEX idx_click_events_file_id ON click_events (file_id);
CREATE INDEX idx_click_events_domain_id ON click_events (domain_id);
CREATE INDEX idx_click_events_clicked_at ON click_events (clicked_at);
CREATE INDEX idx_click_events_country_code ON click_events (country_code);
CREATE INDEX idx_click_events_is_vpn ON click_events (is_vpn);
CREATE INDEX idx_click_events_region ON click_events (region);
CREATE INDEX idx_click_events_city ON click_events (city);
CREATE INDEX idx_click_events_company_domain ON click_events (company_domain);
CREATE INDEX idx_click_events_file_visitor ON click_events (file_id, visitor_id, clicked_at DESC);

CREATE TABLE link_tags (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT
);
CREATE INDEX idx_link_tags_user_id ON link_tags (user_id);

CREATE TABLE link_tag_associations (
  link_id TEXT NOT NULL REFERENCES link_clicks (id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES link_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, tag_id)
);

CREATE TABLE content_items (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL,
  canonical_url TEXT,
  champvault_asset_id TEXT,
  file_id TEXT REFERENCES file_assets (id) ON DELETE SET NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_content_items_org ON content_items (organization_id);
CREATE INDEX idx_content_items_champvault_asset ON content_items (champvault_asset_id);
CREATE UNIQUE INDEX uq_content_items_org_champvault_asset ON content_items (organization_id, champvault_asset_id)
  WHERE champvault_asset_id IS NOT NULL;

CREATE TABLE content_shares (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL REFERENCES content_items (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  shared_by_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  link_id TEXT REFERENCES link_clicks (id) ON DELETE SET NULL,
  file_id TEXT REFERENCES file_assets (id) ON DELETE SET NULL,
  domain_id TEXT REFERENCES domains (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_content_shares_content ON content_shares (content_id);
CREATE INDEX idx_content_shares_org ON content_shares (organization_id);
CREATE INDEX idx_content_shares_user ON content_shares (shared_by_user_id);
CREATE INDEX idx_content_shares_link ON content_shares (link_id);
CREATE INDEX idx_content_shares_file ON content_shares (file_id);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  champvault_asset_id TEXT NOT NULL,
  asset_title TEXT,
  assigned_to_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  assigned_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_assignment_org_asset_assignee ON assignments (organization_id, champvault_asset_id, assigned_to_user_id);
CREATE INDEX idx_assignments_org ON assignments (organization_id);
CREATE INDEX idx_assignments_asset ON assignments (champvault_asset_id);
CREATE INDEX idx_assignments_assignee ON assignments (assigned_to_user_id);

CREATE TABLE champvault_favorites (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  champvault_asset_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_favorite_user_asset ON champvault_favorites (user_id, champvault_asset_id);
CREATE INDEX idx_champvault_favorites_user ON champvault_favorites (user_id);
CREATE INDEX idx_champvault_favorites_asset ON champvault_favorites (champvault_asset_id);

CREATE TABLE access_leads (
  id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT REFERENCES link_clicks (id) ON DELETE CASCADE,
  file_id TEXT REFERENCES file_assets (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_access_leads_link ON access_leads (link_id);
CREATE INDEX idx_access_leads_file ON access_leads (file_id);
CREATE INDEX idx_access_leads_created ON access_leads (created_at);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  bucket TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  asset_ids TEXT NOT NULL DEFAULT '[]',
  personalization TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX idx_rooms_slug ON rooms (slug);
CREATE INDEX idx_rooms_org ON rooms (organization_id);

CREATE TABLE room_recipients (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  name TEXT,
  company TEXT,
  email TEXT,
  bucket TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_room_recipients_room ON room_recipients (room_id);
CREATE INDEX idx_room_recipients_org ON room_recipients (organization_id);

CREATE TABLE room_links (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  recipient_id TEXT REFERENCES room_recipients (id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE UNIQUE INDEX idx_room_links_token ON room_links (token);
CREATE INDEX idx_room_links_room ON room_links (room_id);
CREATE INDEX idx_room_links_recipient ON room_links (recipient_id);

CREATE TABLE room_events (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  link_id TEXT REFERENCES room_links (id) ON DELETE SET NULL,
  recipient_id TEXT REFERENCES room_recipients (id) ON DELETE SET NULL,
  session_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  country TEXT,
  city TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_room_events_room ON room_events (room_id);
CREATE INDEX idx_room_events_link ON room_events (link_id);
CREATE INDEX idx_room_events_recipient ON room_events (recipient_id);
CREATE INDEX idx_room_events_session ON room_events (session_id);
CREATE INDEX idx_room_events_created ON room_events (created_at);

CREATE TABLE page_engagements (
  id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL REFERENCES file_assets (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  visitor_id TEXT,
  page INTEGER NOT NULL,
  dwell_ms INTEGER NOT NULL,
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_page_engagements_file ON page_engagements (file_id);
CREATE INDEX idx_page_engagements_session ON page_engagements (session_id);
CREATE INDEX idx_page_engagements_created ON page_engagements (created_at);
CREATE INDEX ix_page_engagements_visitor_id ON page_engagements (visitor_id);

CREATE TABLE page_comments (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES file_assets (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  visitor_id TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_page_comments_page_created ON page_comments (page_id, created_at);

CREATE TABLE page_state (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES file_assets (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL,
  updated_by_visitor TEXT
);
CREATE UNIQUE INDEX uq_page_state_page_key ON page_state (page_id, key);

CREATE TABLE page_events (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES file_assets (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  ref TEXT,
  visitor_id TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_page_events_page_created ON page_events (page_id, created_at);

CREATE TABLE maxmind_usage (
  day TEXT PRIMARY KEY NOT NULL,
  lookups INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  queries_remaining INTEGER,
  updated_at TEXT NOT NULL
);

-- Replaces Redis: fixed-window counters for rate limits (API keys, service
-- keys, access-code attempts, Beam State writes). Strongly consistent, so
-- limits are exact. Expired rows are purged by the */15 cron.
CREATE TABLE rate_counters (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_counters_expires ON rate_counters (expires_at);
