-- Assistant provider config: a global singleton row (id = 1), ported from backend/app/models/assistant_config.py.
-- API keys never live here; they are Worker secrets (ASSISTANT_OPENROUTER_API_KEY, ASSISTANT_VERCEL_API_KEY).
-- Idempotent and additive. The row is created lazily from env defaults on first read, or loaded from Railway
-- by worker/scripts/export_postgres_to_d1.py (assistant_config is in its TABLE_ORDER).
CREATE TABLE IF NOT EXISTS assistant_config (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
