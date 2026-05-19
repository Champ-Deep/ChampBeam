"""Add password_changed_at to users for JWT invalidation after reset.

Revision ID: 007_pwd_changed_at
Revises: 006_password_reset
Create Date: 2026-05-19 20:55:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "007_pwd_changed_at"
down_revision = "006_password_reset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("password_changed_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "password_changed_at")
