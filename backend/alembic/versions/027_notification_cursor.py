"""Persist the per-user notification dismissal cursor.

Revision ID: 027_notification_cursor
Revises: 026_maxmind_usage
"""

from alembic import op

revision = "027_notification_cursor"
down_revision = "026_maxmind_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_cleared_at TIMESTAMP")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS notifications_cleared_at")
