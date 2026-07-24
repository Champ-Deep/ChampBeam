"""Add organization_memberships.leader_user_id for the team hierarchy.

A member (sales rep / account manager) can be assigned to a leader within the
same org. A leader's team analytics are scoped to the reps that point at them;
super admins (role ending in "admin") still see the whole org. App-managed —
Clerk owns roles, ChampBeam owns the leader->rep assignment.

Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 015_membership_leader
Revises: 014_champvault_favorites
"""

from alembic import op


revision = "015_membership_leader"
down_revision = "014_champvault_favorites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE organization_memberships "
        "ADD COLUMN IF NOT EXISTS leader_user_id UUID REFERENCES users(id) ON DELETE SET NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_org_memberships_leader "
        "ON organization_memberships (leader_user_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_org_memberships_leader")
    op.execute("ALTER TABLE organization_memberships DROP COLUMN IF EXISTS leader_user_id")
