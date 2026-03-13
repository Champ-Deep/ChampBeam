"""Add UTM tracking tables: utm_presets, link_clicks

Revision ID: 002_utm_tables
Revises: 001_initial
Create Date: 2026-03-13
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "002_utm_tables"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # UTM Presets table
    op.create_table(
        "utm_presets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("is_default", sa.Boolean(), default=False),
        sa.Column("utm_source", sa.String(255), nullable=True),
        sa.Column("utm_medium", sa.String(255), nullable=True),
        sa.Column("utm_campaign", sa.String(255), nullable=True),
        sa.Column("utm_content", sa.String(255), nullable=True),
        sa.Column("utm_term", sa.String(255), nullable=True),
        sa.Column("custom_params", postgresql.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_index("idx_utm_presets_user_id", "utm_presets", ["user_id"])
    op.create_index("idx_utm_presets_user_id_is_default", "utm_presets", ["user_id", "is_default"])

    # Link Clicks table
    op.create_table(
        "link_clicks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_name", sa.String(255), nullable=True),
        sa.Column("original_url", sa.Text(), nullable=False),
        sa.Column("tracked_url", sa.Text(), nullable=True),
        sa.Column("anchor_text", sa.String(500), nullable=True),
        sa.Column("link_position", sa.Integer(), nullable=True),
        sa.Column("utm_source", sa.String(255), nullable=True),
        sa.Column("utm_medium", sa.String(255), nullable=True),
        sa.Column("utm_campaign", sa.String(255), nullable=True),
        sa.Column("utm_content", sa.String(255), nullable=True),
        sa.Column("utm_term", sa.String(255), nullable=True),
        sa.Column("click_count", sa.Integer(), default=0),
        sa.Column("unique_clicks", sa.Integer(), default=0),
        sa.Column("first_clicked_at", sa.DateTime(), nullable=True),
        sa.Column("last_clicked_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_link_clicks_user_id", "link_clicks", ["user_id"])
    op.create_index("idx_link_clicks_user_id_created_at", "link_clicks", ["user_id", "created_at"])
    op.create_index("idx_link_clicks_utm_source", "link_clicks", ["utm_source"])
    op.create_index("idx_link_clicks_utm_campaign", "link_clicks", ["utm_campaign"])
    op.create_index("idx_link_clicks_project_name", "link_clicks", ["project_name"])


def downgrade() -> None:
    op.drop_index("idx_link_clicks_project_name", "link_clicks")
    op.drop_index("idx_link_clicks_utm_campaign", "link_clicks")
    op.drop_index("idx_link_clicks_utm_source", "link_clicks")
    op.drop_index("idx_link_clicks_user_id_created_at", "link_clicks")
    op.drop_index("idx_link_clicks_user_id", "link_clicks")
    op.drop_table("link_clicks")

    op.drop_index("idx_utm_presets_user_id_is_default", "utm_presets")
    op.drop_index("idx_utm_presets_user_id", "utm_presets")
    op.drop_table("utm_presets")
