"""Add file_assets table + extend click_events for file views.

Creates the ``file_assets`` table (one row per uploaded asset), the two
partial unique indexes mirroring the BYOD link-namespacing pattern,
relaxes ``click_events.link_id`` to NULL (a file view has no LinkClick),
and adds ``click_events.file_id`` so views attribute back to the asset.

Idempotent via IF NOT EXISTS / IF EXISTS guards in the same defensive
style as migration 008.

Revision ID: 009_file_assets
Revises: 008_byod_domains
"""

from alembic import op


revision = "009_file_assets"
down_revision = "008_byod_domains"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # === file_assets table ==============================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS file_assets (
            id UUID NOT NULL PRIMARY KEY,
            user_id UUID NOT NULL,
            domain_id UUID,
            short_code VARCHAR(20) NOT NULL,
            filename VARCHAR(255) NOT NULL,
            kind VARCHAR(16) NOT NULL,
            mime_type VARCHAR(127) NOT NULL,
            size_bytes BIGINT NOT NULL DEFAULT 0,
            sha256 VARCHAR(64),
            storage_key VARCHAR(255) NOT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'pending_upload',
            serve_mode VARCHAR(16) NOT NULL DEFAULT 'stream',
            view_count INTEGER NOT NULL DEFAULT 0,
            last_viewed_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_file_assets_user_id ON file_assets (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_file_assets_domain_id ON file_assets (domain_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_file_assets_short_code ON file_assets (short_code)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_file_assets_status ON file_assets (status)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_assets_user_id_created_at "
        "ON file_assets (user_id, created_at DESC)"
    )

    # Partial unique indexes mirror link_clicks (see migration 008): a
    # short_code is unique per Domain, and unique globally within the
    # platform-default bucket.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_short_code_per_domain "
        "ON file_assets (domain_id, short_code) "
        "WHERE domain_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_short_code_global "
        "ON file_assets (short_code) "
        "WHERE domain_id IS NULL"
    )

    # === click_events extensions ========================================
    # link_id was NOT NULL; relax it because a file view has no LinkClick.
    op.execute("ALTER TABLE click_events ALTER COLUMN link_id DROP NOT NULL")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS file_id UUID")
    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_file_id ON click_events (file_id)")
    # FK is added separately so the index creation above is fast.
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'fk_click_events_file_id'
            ) THEN
                ALTER TABLE click_events
                  ADD CONSTRAINT fk_click_events_file_id
                  FOREIGN KEY (file_id) REFERENCES file_assets(id)
                  ON DELETE CASCADE;
            END IF;
        END$$;
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE click_events DROP CONSTRAINT IF EXISTS fk_click_events_file_id")
    op.execute("DROP INDEX IF EXISTS idx_click_events_file_id")
    op.execute("ALTER TABLE click_events DROP COLUMN IF EXISTS file_id")
    # Restore the NOT NULL on link_id only if there are no NULL rows; otherwise
    # leave it nullable so downgrade doesn't fail on data already collected.
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM click_events WHERE link_id IS NULL) THEN
                ALTER TABLE click_events ALTER COLUMN link_id SET NOT NULL;
            END IF;
        END$$;
    """)

    op.execute("DROP INDEX IF EXISTS idx_file_assets_short_code_global")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_short_code_per_domain")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_user_id_created_at")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_status")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_short_code")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_domain_id")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_user_id")
    op.execute("DROP TABLE IF EXISTS file_assets")
