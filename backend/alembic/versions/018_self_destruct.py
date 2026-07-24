"""Access controls (security console) on links and files.

Self-destruct (hard expiry, burn-after-N views, manual kill) plus an email gate
(lead capture), VPN/proxy block, and a branded-page flag — all enforced at serve
time. Adds the access_leads table for emails captured at the gate.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 018_self_destruct
Revises: 017_company_intel
"""

from alembic import op


revision = "018_self_destruct"
down_revision = "017_company_intel"
branch_labels = None
depends_on = None


# (column, type, default-clause) added to BOTH link_clicks and file_assets,
# except link expiry (files already have expires_at).
_CONTROLS = [
    ("max_views", "INTEGER", ""),
    ("revoked_at", "TIMESTAMP", ""),
    ("require_email", "BOOLEAN", "NOT NULL DEFAULT false"),
    ("block_vpn", "BOOLEAN", "NOT NULL DEFAULT false"),
    ("branded", "BOOLEAN", "NOT NULL DEFAULT false"),
]


def upgrade() -> None:
    op.execute("ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP")
    op.execute("CREATE INDEX IF NOT EXISTS idx_link_clicks_expires_at ON link_clicks (expires_at)")
    for table in ("link_clicks", "file_assets"):
        for name, ddl_type, default in _CONTROLS:
            op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {name} {ddl_type} {default}".rstrip())

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS access_leads (
            id UUID PRIMARY KEY,
            link_id UUID REFERENCES link_clicks(id) ON DELETE CASCADE,
            file_id UUID REFERENCES file_assets(id) ON DELETE CASCADE,
            email VARCHAR(320) NOT NULL,
            ip_address VARCHAR(45),
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_access_leads_link ON access_leads (link_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_access_leads_file ON access_leads (file_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_access_leads_created ON access_leads (created_at)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS access_leads")
    for table in ("link_clicks", "file_assets"):
        for name, _t, _d in _CONTROLS:
            op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {name}")
    op.execute("DROP INDEX IF EXISTS idx_link_clicks_expires_at")
    op.execute("ALTER TABLE link_clicks DROP COLUMN IF EXISTS expires_at")
