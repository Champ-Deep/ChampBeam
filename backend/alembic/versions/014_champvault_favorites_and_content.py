"""ChampVault library: per-user favorites + shadow content for org sendouts.

Two additions that let ChampBeam's library sit on top of the external ChampVault
hub:

- ``champvault_favorites``: a user's favorited assets (the "My Favorites" shelf).
- ``content_items.champvault_asset_id``: marks a library row as the org's shadow
  of a ChampVault asset, created lazily the first time a member sends it. A
  partial unique index keeps it to one shadow row per (organization, asset) so
  every member's send rolls up to the same content in team analytics.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 014_champvault_favorites_and_content
Revises: 013_champvault_asset_id
"""

from alembic import op


revision = "014_champvault_favorites_and_content"
down_revision = "013_champvault_asset_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Shadow-content marker on the existing library table.
    op.execute(
        "ALTER TABLE content_items ADD COLUMN IF NOT EXISTS champvault_asset_id VARCHAR(64)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_content_items_champvault_asset "
        "ON content_items (champvault_asset_id)"
    )
    # One shadow row per (org, asset) so sends consolidate under one content id.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_content_items_org_champvault_asset "
        "ON content_items (organization_id, champvault_asset_id) "
        "WHERE champvault_asset_id IS NOT NULL"
    )

    # Per-user favorites over the ChampVault library.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS champvault_favorites (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            champvault_asset_id VARCHAR(64) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT uq_favorite_user_asset UNIQUE (user_id, champvault_asset_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_champvault_favorites_user "
        "ON champvault_favorites (user_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_champvault_favorites_asset "
        "ON champvault_favorites (champvault_asset_id)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS champvault_favorites")
    op.execute("DROP INDEX IF EXISTS uq_content_items_org_champvault_asset")
    op.execute("DROP INDEX IF EXISTS idx_content_items_champvault_asset")
    op.execute("ALTER TABLE content_items DROP COLUMN IF EXISTS champvault_asset_id")
