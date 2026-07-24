"""Add company-intent (reverse-IP firmographics) columns to click_events.

Populated async (like geo) when a company-intel provider is configured. The
"asn" provider leaves these NULL and analytics falls back to the existing
asn_org column, so the feature works at $0 and upgrades to real firmographics
(e.g. IPinfo) by just setting a token.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 017_company_intel
Revises: 016_assignments
"""

from alembic import op


revision = "017_company_intel"
down_revision = "016_assignments"
branch_labels = None
depends_on = None


_COLUMNS = [
    ("company_name", "VARCHAR(255)"),
    ("company_domain", "VARCHAR(255)"),
    ("company_industry", "VARCHAR(128)"),
    ("company_size", "VARCHAR(64)"),
    ("company_type", "VARCHAR(32)"),
]


def upgrade() -> None:
    for name, ddl_type in _COLUMNS:
        op.execute(f"ALTER TABLE click_events ADD COLUMN IF NOT EXISTS {name} {ddl_type}")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_click_events_company_domain "
        "ON click_events (company_domain)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_click_events_company_domain")
    for name, _ in _COLUMNS:
        op.execute(f"ALTER TABLE click_events DROP COLUMN IF EXISTS {name}")
