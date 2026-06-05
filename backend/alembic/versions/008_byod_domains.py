"""Add domains table and per-account short_code namespacing for BYOD.

Adds the ``domains`` table (one row per user-attached custom hostname),
introduces nullable ``domain_id`` foreign keys on ``link_clicks`` and
``click_events``, and replaces the global unique index on
``link_clicks.short_code`` with two partial unique indexes so short codes
are unique-per-domain while the platform default (``domain_id IS NULL``)
keeps its global namespace.

Idempotent via IF NOT EXISTS / IF EXISTS guards in the same defensive
style as migration 007_repair_legacy.

Revision ID: 008_byod_domains
Revises: 007_repair_legacy
"""

from alembic import op


revision = "008_byod_domains"
down_revision = "007_repair_legacy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # === domains table ==================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS domains (
            id UUID NOT NULL PRIMARY KEY,
            user_id UUID NOT NULL,
            hostname VARCHAR(253) NOT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'pending_cname',
            cf_custom_hostname_id VARCHAR(64),
            ssl_status VARCHAR(64),
            verification_errors JSONB,
            is_primary BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            verified_at TIMESTAMP,
            last_checked_at TIMESTAMP
        )
    """)
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_hostname ON domains (hostname)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_domains_user_id ON domains (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_domains_status ON domains (status)")
    # Enforce at most one primary domain per user. Partial unique allows many
    # non-primary rows; only the row with is_primary=true is constrained.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_user_primary "
        "ON domains (user_id) WHERE is_primary = true"
    )

    # === link_clicks.domain_id ==========================================
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS domain_id UUID")
    op.execute("CREATE INDEX IF NOT EXISTS idx_link_clicks_domain_id ON link_clicks (domain_id)")

    # === click_events.domain_id =========================================
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS domain_id UUID")
    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_domain_id ON click_events (domain_id)")

    # === Replace global short_code uniqueness with two partial uniques ===
    # Drop the old global unique index if it exists. Use IF EXISTS so this is
    # safe to re-run.
    op.execute("DROP INDEX IF EXISTS idx_link_clicks_short_code")
    # Per-domain uniqueness (custom-domain links).
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_link_clicks_short_code_per_domain "
        "ON link_clicks (domain_id, short_code) "
        "WHERE domain_id IS NOT NULL AND short_code IS NOT NULL"
    )
    # Global uniqueness within the platform-default bucket.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_link_clicks_short_code_global "
        "ON link_clicks (short_code) "
        "WHERE domain_id IS NULL AND short_code IS NOT NULL"
    )


def downgrade() -> None:
    # Restore the global unique on short_code so existing code expecting it
    # still works after a rollback.
    op.execute("DROP INDEX IF EXISTS idx_link_clicks_short_code_per_domain")
    op.execute("DROP INDEX IF EXISTS idx_link_clicks_short_code_global")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_link_clicks_short_code "
        "ON link_clicks (short_code)"
    )

    op.execute("DROP INDEX IF EXISTS idx_click_events_domain_id")
    op.execute("ALTER TABLE click_events DROP COLUMN IF EXISTS domain_id")

    op.execute("DROP INDEX IF EXISTS idx_link_clicks_domain_id")
    op.execute("ALTER TABLE link_clicks DROP COLUMN IF EXISTS domain_id")

    op.execute("DROP INDEX IF EXISTS idx_domains_user_primary")
    op.execute("DROP INDEX IF EXISTS idx_domains_status")
    op.execute("DROP INDEX IF EXISTS idx_domains_user_id")
    op.execute("DROP INDEX IF EXISTS idx_domains_hostname")
    op.execute("DROP TABLE IF EXISTS domains")
