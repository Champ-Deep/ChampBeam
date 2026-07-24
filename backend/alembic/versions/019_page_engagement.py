"""Add page_engagements for per-page (PDF) / per-section (HTML) dwell tracking.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 019_page_engagement
Revises: 018_self_destruct
"""

from alembic import op


revision = "019_page_engagement"
down_revision = "018_self_destruct"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS page_engagements (
            id UUID PRIMARY KEY,
            file_id UUID NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
            session_id VARCHAR(64) NOT NULL,
            page INTEGER NOT NULL,
            dwell_ms INTEGER NOT NULL,
            ip_address VARCHAR(45),
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_page_engagements_file ON page_engagements (file_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_page_engagements_session ON page_engagements (session_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_page_engagements_created ON page_engagements (created_at)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS page_engagements")
