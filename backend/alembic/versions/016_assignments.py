"""Add the assignments table (leader → rep soft recommendations).

A leader recommends a ChampVault asset to one of their reps. Soft: it never
gates sending, it just surfaces the asset on the rep's shelf and lets the leader
track whether it was sent. One row per (org, asset, rep).

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 016_assignments
Revises: 015_membership_leader
"""

from alembic import op


revision = "016_assignments"
down_revision = "015_membership_leader"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assignments (
            id UUID PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            champvault_asset_id VARCHAR(64) NOT NULL,
            asset_title VARCHAR(255),
            assigned_to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            note TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT uq_assignment_org_asset_assignee
                UNIQUE (organization_id, champvault_asset_id, assigned_to_user_id)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_assignments_org ON assignments (organization_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_assignments_asset ON assignments (champvault_asset_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_assignments_assignee ON assignments (assigned_to_user_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS assignments")
