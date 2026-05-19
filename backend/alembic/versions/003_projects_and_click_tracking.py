"""Add projects table, click_events table, short_code/project_id on link_clicks

Revision ID: 003_projects_clicks
Revises: 002_utm_tables
Create Date: 2026-03-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "003_projects_clicks"
down_revision: Union[str, None] = "002_utm_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Projects table
    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_projects_user_id", "projects", ["user_id"])

    # 2. Add short_code and project_id to link_clicks
    op.add_column("link_clicks", sa.Column("short_code", sa.String(20), nullable=True))
    op.add_column(
        "link_clicks",
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("idx_link_clicks_short_code", "link_clicks", ["short_code"], unique=True)
    op.create_index("idx_link_clicks_project_id", "link_clicks", ["project_id"])

    # 3. Click events table
    op.create_table(
        "click_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("link_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("link_clicks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("referrer", sa.Text(), nullable=True),
        sa.Column("device_type", sa.String(50), nullable=True),
        sa.Column("browser", sa.String(100), nullable=True),
        sa.Column("os", sa.String(100), nullable=True),
        sa.Column("country", sa.String(100), nullable=True),
        sa.Column("country_code", sa.String(2), nullable=True),
        sa.Column("region", sa.String(100), nullable=True),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("clicked_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("idx_click_events_link_id", "click_events", ["link_id"])
    op.create_index("idx_click_events_clicked_at", "click_events", ["clicked_at"])
    op.create_index("idx_click_events_country_code", "click_events", ["country_code"])


def downgrade() -> None:
    op.drop_index("idx_click_events_country_code", "click_events")
    op.drop_index("idx_click_events_clicked_at", "click_events")
    op.drop_index("idx_click_events_link_id", "click_events")
    op.drop_table("click_events")

    op.drop_index("idx_link_clicks_project_id", "link_clicks")
    op.drop_index("idx_link_clicks_short_code", "link_clicks")
    op.drop_column("link_clicks", "project_id")
    op.drop_column("link_clicks", "short_code")

    op.drop_index("idx_projects_user_id", "projects")
    op.drop_table("projects")
