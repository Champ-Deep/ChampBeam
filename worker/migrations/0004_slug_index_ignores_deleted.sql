-- Slug uniqueness must ignore deleted rows (mirrors backend alembic 030).
-- slugTaken() and every delete path treat status='deleted' as free, but 0001's
-- unique indexes covered them, so a deleted page kept its slug locked (re-add
-- 409) and the GET /pages slug backfill hit the index (500).
DROP INDEX IF EXISTS idx_file_assets_slug_per_domain;
DROP INDEX IF EXISTS idx_file_assets_slug_global;
CREATE UNIQUE INDEX idx_file_assets_slug_per_domain ON file_assets (domain_id, slug)
  WHERE domain_id IS NOT NULL AND slug IS NOT NULL AND status <> 'deleted';
CREATE UNIQUE INDEX idx_file_assets_slug_global ON file_assets (slug)
  WHERE domain_id IS NULL AND slug IS NOT NULL AND status <> 'deleted';
