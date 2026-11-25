-- Per-job model override for agent jobs. No row = use assistant_config.model. Provider stays global.
CREATE TABLE IF NOT EXISTS assistant_job_models (
  job TEXT PRIMARY KEY NOT NULL CHECK (job IN ('forward_followup', 'page_from_brief')),
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
