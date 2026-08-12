"""Add api_keys: per-user credentials for server-to-server integrations.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 021_api_keys
Revises: 020_briefing_rooms
"""

from alembic import op


revision = "021_api_keys"
down_revision = "020_briefing_rooms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS api_keys (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(100) NOT NULL,
            key_prefix VARCHAR(16) NOT NULL,
            key_hash VARCHAR(64) NOT NULL,
            scopes JSON,
            last_used_at TIMESTAMP,
            expires_at TIMESTAMP,
            revoked_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS api_keys")
