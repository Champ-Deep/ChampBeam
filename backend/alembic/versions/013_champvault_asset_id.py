"""Add link_clicks.champvault_asset_id for ChampVault-backed beams.

A link that wraps a ChampVault asset stores the asset id here; the redirect
handler re-mints a fresh delivery URL on each open so the beam never breaks when
a previously-minted (short-lived) delivery URL expires.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 013_champvault_asset_id
Revises: 012_org_content_procurement
"""

from alembic import op


revision = "013_champvault_asset_id"
down_revision = "012_org_content_procurement"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS champvault_asset_id VARCHAR(64)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_link_clicks_champvault_asset "
        "ON link_clicks (champvault_asset_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_link_clicks_champvault_asset")
    op.execute("ALTER TABLE link_clicks DROP COLUMN IF EXISTS champvault_asset_id")
