"""Assistant configuration (singleton row).

One row, id = 1, holding the admin-chosen provider (openrouter | vercel |
mock), the model name, and the global enabled flag. API keys stay in the
environment (never in the DB); ``*_configured`` in the config endpoint tells
the UI which providers can actually be used. The row overrides the env
defaults when present; ``assistant_enabled=false`` in env kills it regardless.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 028_assistant_config
Revises: 027_pages_v2_link_aliases
"""

from alembic import op

revision = "028_assistant_config"
down_revision = "027_pages_v2_link_aliases"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assistant_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            provider VARCHAR(32) NOT NULL DEFAULT 'openrouter',
            model VARCHAR(160) NOT NULL DEFAULT 'meta-llama/llama-3.3-70b-instruct:free',
            enabled BOOLEAN NOT NULL DEFAULT true,
            updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
        )
        """
    )
    op.execute(
        """
        INSERT INTO assistant_config (id, provider, model, enabled)
        VALUES (1, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free', true)
        ON CONFLICT (id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS assistant_config")