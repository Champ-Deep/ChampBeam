"""Beam State + access codes.

- file_assets.state_token: page-scoped public token injected into served HTML
  so the page can read/write its own comments + key-value state.
- file_assets.access_code_hash: keyed HMAC of the 4–8 digit access code.
- page_comments: append-only comment stream per page.
- page_state: namespaced JSON key-value per page (last-writer-wins).
- page_events: typed page events (comment_added, state_changed, gate_failed)
  kept OUT of click_events so open counts stay correct.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 025_beam_state
Revises: 024_beam_pages
"""

from alembic import op


revision = "025_beam_state"
down_revision = "024_beam_pages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS state_token VARCHAR(64)")
    op.execute("ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS access_code_hash VARCHAR(64)")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS page_comments (
            id UUID PRIMARY KEY,
            page_id UUID NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
            author VARCHAR(120) NOT NULL,
            body TEXT NOT NULL,
            visitor_id VARCHAR(64),
            ip VARCHAR(45),
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_page_comments_page_created ON page_comments (page_id, created_at)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS page_state (
            id UUID PRIMARY KEY,
            page_id UUID NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
            key VARCHAR(120) NOT NULL,
            value JSONB,
            updated_at TIMESTAMP NOT NULL DEFAULT now(),
            updated_by_visitor VARCHAR(64)
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_page_state_page_key ON page_state (page_id, key)")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS page_events (
            id UUID PRIMARY KEY,
            page_id UUID NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
            event_type VARCHAR(32) NOT NULL,
            ref VARCHAR(160),
            visitor_id VARCHAR(64),
            ip VARCHAR(45),
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_page_events_page_created ON page_events (page_id, created_at)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS page_events")
    op.execute("DROP TABLE IF EXISTS page_state")
    op.execute("DROP TABLE IF EXISTS page_comments")
    op.execute("ALTER TABLE file_assets DROP COLUMN IF EXISTS access_code_hash")
    op.execute("ALTER TABLE file_assets DROP COLUMN IF EXISTS state_token")
