"""Pages V2 + named links.

- file_versions.rewrite_report JSONB: per-version audit of link rewrites applied
  at publish/replace time ({from_href, to_url, kind} rows). Nullable, never
  part of the served bytes.
- page_link_routes: literal-href → target overrides for one page. Applied when
  a new version is produced (the "reroute without editing HTML" panel), and
  recorded so future replaces keep honoring them.
- link_clicks.alias: user-named short link (/s/{alias}) next to the random
  short_code. Unique per domain namespace, mirroring migration 008's partial
  indexes (one global where domain_id IS NULL, one per domain).

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 027_pages_v2_link_aliases
Revises: 026_maxmind_usage
"""

from alembic import op

revision = "027_pages_v2_link_aliases"
down_revision = "026_maxmind_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS rewrite_report JSONB"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS page_link_routes (
            id UUID PRIMARY KEY,
            page_id UUID NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
            src_href TEXT NOT NULL,
            target_url TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_page_link_routes_page_id ON page_link_routes (page_id)"
    )

    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS alias VARCHAR(80)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_link_clicks_alias ON link_clicks (alias)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_link_clicks_alias_per_domain "
        "ON link_clicks (domain_id, alias) WHERE domain_id IS NOT NULL AND alias IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_link_clicks_alias_global "
        "ON link_clicks (alias) WHERE domain_id IS NULL AND alias IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_link_clicks_alias_global")
    op.execute("DROP INDEX IF EXISTS idx_link_clicks_alias_per_domain")
    op.execute("DROP INDEX IF EXISTS ix_link_clicks_alias")
    op.execute("ALTER TABLE link_clicks DROP COLUMN IF EXISTS alias")
    op.execute("DROP TABLE IF EXISTS page_link_routes")
    op.execute("ALTER TABLE file_versions DROP COLUMN IF EXISTS rewrite_report")