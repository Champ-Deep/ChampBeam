-- Better Auth on D1 (docs/BETTER-AUTH-PRD.md section 4). Additive only: the Clerk build runs on this
-- schema unchanged, so a rollback needs no down migration. Tables and columns are what the Better Auth
-- 1.7.18 drizzle generator emits for sqlite (integer timestamp_ms dates, snake_case columns).

-- Better Auth's user model on our users table.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;
-- Better Auth requires user.name (full_name): fall back to the email local part.
UPDATE users SET full_name = substr(email, 1, instr(email, '@') - 1)
  WHERE (full_name IS NULL OR trim(full_name) = '') AND instr(email, '@') > 1;

-- Better Auth's organization model on our organizations table.
ALTER TABLE organizations ADD COLUMN logo TEXT;
ALTER TABLE organizations ADD COLUMN metadata TEXT;
-- Better Auth requires a unique slug. A missing slug, or any duplicate after the oldest holder, becomes
-- slugified name plus a short id. The oldest org keeps its slug, so known slugs (champions-group) stay.
UPDATE organizations
  SET slug = lower(replace(trim(coalesce(nullif(trim(name), ''), 'org')), ' ', '-')) || '-' || substr(id, 1, 8)
  WHERE slug IS NULL OR trim(slug) = ''
     OR EXISTS (
       SELECT 1 FROM organizations o
       WHERE o.slug = organizations.slug
         AND (o.created_at < organizations.created_at OR (o.created_at = organizations.created_at AND o.id < organizations.id))
     );
CREATE UNIQUE INDEX organizations_slug_uidx ON organizations (slug);

CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  active_organization_id TEXT
);
CREATE UNIQUE INDEX session_token_unique ON session (token);
CREATE INDEX session_userId_idx ON session (user_id);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX account_userId_idx ON account (user_id);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  updated_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification (identifier);

CREATE TABLE invitation (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT,
  status TEXT DEFAULT 'pending' NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX invitation_organizationId_idx ON invitation (organization_id);
CREATE INDEX invitation_email_idx ON invitation (email);

-- rateLimit.storage = "database": per-isolate memory is useless on Workers.
CREATE TABLE rate_limit (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);
CREATE UNIQUE INDEX rate_limit_key_unique ON rate_limit (key);
