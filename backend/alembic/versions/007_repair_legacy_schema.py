"""Reconcile legacy create_all schema with migrations 003 / 004 / 005.

The Railway Postgres was originally bootstrapped via ``Base.metadata.create_all()``
against a model snapshot that pre-dated migrations 003 (projects table,
click_events table, link_clicks.short_code/project_id) and 004 (latitude,
longitude, is_vpn, link_tags, link_tag_associations). The bootstrap_db.py
shim then stamped alembic_version at 52f5b4d7d10e on every boot, so alembic
believed those migrations were already applied and skipped them. Result: the
schema is permanently missing several columns that authenticated endpoints
reference, producing UndefinedColumnError 500s on /api/v1/projects,
/api/v1/utm/analytics/clicks/recent, and others.

This migration uses raw SQL with IF NOT EXISTS on every statement so it is
safe to apply against any partial state, fresh installs, half-bootstrapped
Railway installs, or already-correct installs. FK constraints on the
back-filled columns are intentionally omitted to keep the statements
unconditional; queries only need the columns to exist, not to be FK-enforced.

Revision ID: 007_repair_legacy
Revises: 006_add_clerk_id
"""
from alembic import op


revision = "007_repair_legacy"
down_revision = "006_add_clerk_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # === From migration 003: projects table ===
    op.execute("""
        CREATE TABLE IF NOT EXISTS projects (
            id UUID NOT NULL PRIMARY KEY,
            user_id UUID NOT NULL,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects (user_id)")

    # === From migration 003: link_clicks gets short_code + project_id ===
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS short_code VARCHAR(20)")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS project_id UUID")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_link_clicks_short_code ON link_clicks (short_code)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_link_clicks_project_id ON link_clicks (project_id)")

    # === From migration 003: click_events table ===
    op.execute("""
        CREATE TABLE IF NOT EXISTS click_events (
            id UUID NOT NULL PRIMARY KEY,
            link_id UUID,
            ip_address VARCHAR(45),
            user_agent TEXT,
            referrer TEXT,
            device_type VARCHAR(50),
            browser VARCHAR(100),
            os VARCHAR(100),
            country VARCHAR(100),
            country_code VARCHAR(2),
            region VARCHAR(100),
            city VARCHAR(100),
            clicked_at TIMESTAMP NOT NULL DEFAULT now()
        )
    """)
    # Catch the case where click_events exists but is missing columns. ADD COLUMN
    # IF NOT EXISTS is a no-op when the column is already present.
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS link_id UUID")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS user_agent TEXT")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS referrer TEXT")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS device_type VARCHAR(50)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS browser VARCHAR(100)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS os VARCHAR(100)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS country VARCHAR(100)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS country_code VARCHAR(2)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS region VARCHAR(100)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS city VARCHAR(100)")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMP NOT NULL DEFAULT now()")

    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_link_id ON click_events (link_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_clicked_at ON click_events (clicked_at)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_country_code ON click_events (country_code)")

    # === From migration 004: lat/lon/is_vpn + extra indexes + tag tables ===
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION")
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS is_vpn BOOLEAN NOT NULL DEFAULT false")
    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_is_vpn ON click_events (is_vpn)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_link_clicks_user_campaign ON link_clicks (user_id, utm_campaign)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_region ON click_events (region)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_click_events_city ON click_events (city)")

    op.execute("""
        CREATE TABLE IF NOT EXISTS link_tags (
            id UUID NOT NULL PRIMARY KEY,
            user_id UUID NOT NULL,
            name VARCHAR(100) NOT NULL,
            color VARCHAR(7),
            created_at TIMESTAMP DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_link_tags_user_id ON link_tags (user_id)")

    op.execute("""
        CREATE TABLE IF NOT EXISTS link_tag_associations (
            link_id UUID NOT NULL,
            tag_id UUID NOT NULL,
            PRIMARY KEY (link_id, tag_id)
        )
    """)

    # === From migration 005: asn_org ===
    op.execute("ALTER TABLE click_events ADD COLUMN IF NOT EXISTS asn_org VARCHAR(255)")

    # === Safety net for the migration 002 link_clicks columns ===
    # The model expects all of these. If the legacy create_all snapshot was
    # missing any, this restores them. Idempotent if already present.
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS project_name VARCHAR(255)")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS tracked_url TEXT")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS anchor_text VARCHAR(500)")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS link_position INTEGER")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS unique_clicks INTEGER DEFAULT 0")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMP")
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS last_clicked_at TIMESTAMP")


def downgrade() -> None:
    # No-op: this migration is purely additive and the columns it adds are
    # required by the live model. There's no safe state to roll back to.
    pass
