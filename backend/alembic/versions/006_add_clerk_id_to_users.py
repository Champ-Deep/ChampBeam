"""Add clerk_id to users; relax hashed_password to nullable.

Why this exists: the User model declares ``clerk_id`` (since the
backend migrated to Clerk session tokens) but no migration ever
created the column. Every authenticated request 500s in production
with ``UndefinedColumnError: column users.clerk_id does not exist``.
We also relax ``hashed_password`` to nullable because Clerk-managed
users never have a local password to store.

Revision ID: 006_add_clerk_id
Revises: 52f5b4d7d10e
Create Date: 2026-05-24 10:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "006_add_clerk_id"
down_revision = "52f5b4d7d10e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("clerk_id", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_users_clerk_id",
        "users",
        ["clerk_id"],
        unique=True,
    )
    op.alter_column(
        "users",
        "hashed_password",
        existing_type=sa.String(length=255),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "users",
        "hashed_password",
        existing_type=sa.String(length=255),
        nullable=False,
    )
    op.drop_index("ix_users_clerk_id", table_name="users")
    op.drop_column("users", "clerk_id")
