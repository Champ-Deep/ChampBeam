"""Anonymous + auto-expiring file assets.

Relaxes ``file_assets.user_id`` to NULL (signed-out uploads have no user),
and adds ``expires_at`` (auto-expiry for guest uploads) + ``owner_token_hash``
(lets an anonymous uploader poll view status without an account). A partial
index on ``expires_at`` keeps the expiry sweep cheap, authed rows are NULL.

Idempotent via IF NOT EXISTS / IF EXISTS guards in the same defensive style
as migration 009.

Revision ID: 010_anon_expiring_files
Revises: 009_file_assets
"""

from alembic import op


revision = "010_anon_expiring_files"
down_revision = "009_file_assets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE file_assets ALTER COLUMN user_id DROP NOT NULL")
    op.execute("ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP")
    op.execute("ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS owner_token_hash VARCHAR(64)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_assets_expires_at "
        "ON file_assets (expires_at) "
        "WHERE expires_at IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_file_assets_expires_at")
    op.execute("ALTER TABLE file_assets DROP COLUMN IF EXISTS owner_token_hash")
    op.execute("ALTER TABLE file_assets DROP COLUMN IF EXISTS expires_at")
    # Restore NOT NULL on user_id only if no anonymous (NULL) rows exist;
    # otherwise leave it nullable so downgrade doesn't fail on collected data.
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM file_assets WHERE user_id IS NULL) THEN
                ALTER TABLE file_assets ALTER COLUMN user_id SET NOT NULL;
            END IF;
        END$$;
    """)
