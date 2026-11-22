"""Intranet P1: malware scan status, reminders, review agent results, benchmark runs.

Revision ID: 032_intranet_p1
Revises: 031_intranet_transfers
"""

from alembic import op

revision = "032_intranet_p1"
down_revision = "031_intranet_transfers"
branch_labels = None
depends_on = None

_TRANSFER_COLUMNS = (
    ("scan_status", "VARCHAR(20)"),
    ("scan_detail", "TEXT"),
    ("scanned_at", "TIMESTAMP"),
    ("reminded_at", "TIMESTAMP"),
    ("escalated_at", "TIMESTAMP"),
    ("escalation_reason", "TEXT"),
    ("agent_evaluated_at", "TIMESTAMP"),
    ("agent_result", "JSONB"),
)


def upgrade() -> None:
    for name, ddl in _TRANSFER_COLUMNS:
        op.execute(f"ALTER TABLE transfers ADD COLUMN IF NOT EXISTS {name} {ddl}")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_benchmarks (
            id UUID PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            provider VARCHAR(40) NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'running',
            created_at TIMESTAMP NOT NULL,
            finished_at TIMESTAMP,
            created_by_id VARCHAR(255),
            report JSONB,
            error TEXT
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_agent_benchmarks_organization_id ON agent_benchmarks (organization_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_benchmarks")
    for name, _ in reversed(_TRANSFER_COLUMNS):
        op.execute(f"ALTER TABLE transfers DROP COLUMN IF EXISTS {name}")
