"""Add briefing rooms: rooms, room_recipients, room_links, room_events.

Hosted Briefing Rooms + identified visit tracking (functional spec v1.0,
Modules B & C). Idempotent via IF NOT EXISTS, matching the defensive style of
prior migrations so a re-run against an already-migrated DB is a no-op.

Revision ID: 020_briefing_rooms
Revises: 019_page_engagement
"""

from alembic import op


revision = "020_briefing_rooms"
down_revision = "019_page_engagement"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS rooms (
            id UUID PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            title VARCHAR(255) NOT NULL,
            slug VARCHAR(80) NOT NULL,
            bucket VARCHAR(80),
            state VARCHAR(16) NOT NULL DEFAULT 'draft',
            asset_ids JSON NOT NULL DEFAULT '[]',
            personalization JSON NOT NULL DEFAULT '{}',
            published_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            updated_at TIMESTAMP
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_slug ON rooms (slug)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_rooms_org ON rooms (organization_id)")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS room_recipients (
            id UUID PRIMARY KEY,
            room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            name VARCHAR(255),
            company VARCHAR(255),
            email VARCHAR(320),
            bucket VARCHAR(80),
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_recipients_room ON room_recipients (room_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_recipients_org ON room_recipients (organization_id)")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS room_links (
            id UUID PRIMARY KEY,
            room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            recipient_id UUID REFERENCES room_recipients(id) ON DELETE CASCADE,
            token VARCHAR(64) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            expires_at TIMESTAMP
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_room_links_token ON room_links (token)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_links_room ON room_links (room_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_links_recipient ON room_links (recipient_id)")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS room_events (
            id UUID PRIMARY KEY,
            room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            link_id UUID REFERENCES room_links(id) ON DELETE SET NULL,
            recipient_id UUID REFERENCES room_recipients(id) ON DELETE SET NULL,
            session_id VARCHAR(64),
            type VARCHAR(32) NOT NULL,
            payload JSON NOT NULL DEFAULT '{}',
            country VARCHAR(100),
            city VARCHAR(100),
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_events_room ON room_events (room_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_events_link ON room_events (link_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_events_recipient ON room_events (recipient_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_room_events_created ON room_events (created_at)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS room_events")
    op.execute("DROP TABLE IF EXISTS room_links")
    op.execute("DROP TABLE IF EXISTS room_recipients")
    op.execute("DROP TABLE IF EXISTS rooms")
