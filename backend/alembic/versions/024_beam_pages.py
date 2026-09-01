"""Beam Pages P0: editable slugs, visitor ids + revisits, retained versions.

- file_assets.slug: URL-safe editable slug served at /p/{slug}, unique within
  the same domain namespace as short_code (mirrors migration 009).
- click_events.visitor_id / is_revisit: first-party visitor identity and the
  "same visitor came back after the revisit window" flag. One row per view so
  every existing count(click_events) stays correct.
- page_engagements.visitor_id: dwell rows attributable to a visitor.
- file_versions: retained content versions for rollback.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 024_beam_pages
Revises: 023_widen_geo_columns
"""

from alembic import op


revision = "024_beam_pages"
down_revision = "023_widen_geo_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS slug VARCHAR(80)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_file_assets_slug ON file_assets (slug)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_slug_per_domain "
        "ON file_assets (domain_id, slug) WHERE domain_id IS NOT NULL AND slug IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_slug_global "
        "ON file_assets (slug) WHERE domain_id IS NULL AND slug IS NOT NULL"
    )

    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS visitor_id VARCHAR(32)")
    op.execute(
        "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS is_revisit BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_click_events_file_visitor "
        "ON click_events (file_id, visitor_id, clicked_at DESC)"
    )

    op.execute("ALTER TABLE page_engagements ADD COLUMN IF NOT EXISTS visitor_id VARCHAR(32)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_page_engagements_visitor_id ON page_engagements (visitor_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS file_versions (
            id UUID PRIMARY KEY,
            file_id UUID NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
            version_no INTEGER NOT NULL,
            storage_key VARCHAR(255) NOT NULL,
            size_bytes BIGINT NOT NULL DEFAULT 0,
            sha256 VARCHAR(64),
            filename VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_file_versions_file_id ON file_versions (file_id)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_file_versions_file_no ON file_versions (file_id, version_no)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS file_versions")
    op.execute("DROP INDEX IF EXISTS ix_page_engagements_visitor_id")
    op.execute("ALTER TABLE page_engagements DROP COLUMN IF EXISTS visitor_id")
    op.execute("DROP INDEX IF EXISTS idx_click_events_file_visitor")
    op.execute("ALTER TABLE click_events DROP COLUMN IF EXISTS is_revisit")
    op.execute("ALTER TABLE click_events DROP COLUMN IF EXISTS visitor_id")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_slug_global")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_slug_per_domain")
    op.execute("DROP INDEX IF EXISTS ix_file_assets_slug")
    op.execute("ALTER TABLE file_assets DROP COLUMN IF EXISTS slug")
