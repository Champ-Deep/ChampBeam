"""Add clerk_id to users; relax hashed_password to nullable.

Idempotent on purpose: the deployed Railway Postgres was originally
bootstrapped via ``Base.metadata.create_all()``, so it can be in a
mixed state where some of these changes were already made out-of-band
(e.g., by a hand-applied ALTER). Using raw SQL with ``IF NOT EXISTS``
makes this migration safe to run against any of those shapes.

Revision ID: 006_add_clerk_id
Revises: 52f5b4d7d10e
Create Date: 2026-05-24 10:00:00.000000
"""
from alembic import op


revision = "006_add_clerk_id"
down_revision = "52f5b4d7d10e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_id VARCHAR(255)")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_clerk_id ON users (clerk_id)")
    # DROP NOT NULL is naturally idempotent in Postgres — succeeds whether
    # the column was previously NOT NULL or already nullable.
    op.execute("ALTER TABLE users ALTER COLUMN hashed_password DROP NOT NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE users ALTER COLUMN hashed_password SET NOT NULL")
    op.execute("DROP INDEX IF EXISTS ix_users_clerk_id")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS clerk_id")
