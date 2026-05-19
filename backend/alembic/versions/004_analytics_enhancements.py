"""Add lat/lon/is_vpn to click_events, campaign/geo indexes, link tags tables

Revision ID: 004_analytics_enhancements
Revises: 003_projects_clicks
Create Date: 2026-03-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "004_analytics_enhancements"
down_revision: Union[str, None] = "003_projects_clicks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. GeoIP enhancements: add latitude/longitude to click_events
    op.add_column("click_events", sa.Column("latitude", sa.Float(), nullable=True))
    op.add_column("click_events", sa.Column("longitude", sa.Float(), nullable=True))

    # VPN/proxy detection
    op.add_column("click_events", sa.Column("is_vpn", sa.Boolean(), server_default="false", nullable=False))
    op.create_index("idx_click_events_is_vpn", "click_events", ["is_vpn"])

    # 2. Campaign analytics: composite index for fast campaign queries
    op.create_index("idx_link_clicks_user_campaign", "link_clicks", ["user_id", "utm_campaign"])

    # 3. Geo analytics: indexes for region/city aggregate queries
    op.create_index("idx_click_events_region", "click_events", ["region"])
    op.create_index("idx_click_events_city", "click_events", ["city"])

    # 4. Link tags
    op.create_table(
        "link_tags",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("color", sa.String(7), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_link_tags_user_id", "link_tags", ["user_id"])

    # 5. Link-tag associations (many-to-many)
    op.create_table(
        "link_tag_associations",
        sa.Column("link_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("link_clicks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("link_tags.id", ondelete="CASCADE"), primary_key=True),
    )


def downgrade() -> None:
    op.drop_table("link_tag_associations")
    op.drop_index("idx_link_tags_user_id", "link_tags")
    op.drop_table("link_tags")

    op.drop_index("idx_click_events_city", "click_events")
    op.drop_index("idx_click_events_region", "click_events")
    op.drop_index("idx_link_clicks_user_campaign", "link_clicks")

    op.drop_column("click_events", "longitude")
    op.drop_column("click_events", "latitude")

    op.drop_index("idx_click_events_is_vpn", "click_events")
    op.drop_column("click_events", "is_vpn")
