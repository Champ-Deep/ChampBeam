"""Add asn_org column to click_events for ASN-based VPN detection.

Revision ID: 005
Revises: 004
"""

from alembic import op
import sqlalchemy as sa

revision = "005_add_asn_org"
down_revision = "004_analytics_enhancements"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("click_events", sa.Column("asn_org", sa.String(255), nullable=True))


def downgrade():
    op.drop_column("click_events", "asn_org")
