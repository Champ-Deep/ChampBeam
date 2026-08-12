"""Add self-hosted provisioning columns to domains.

Tracks when the host-side provisioner was asked to issue a vhost + cert for a
BYOD hostname, and how many attempts have been made (3 strikes -> failed).
Idempotent via IF NOT EXISTS, matching the defensive style of prior migrations.

Revision ID: 022_domain_provisioning
Revises: 021_api_keys
"""

from alembic import op


revision = "022_domain_provisioning"
down_revision = "021_api_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE domains ADD COLUMN IF NOT EXISTS provision_requested_at TIMESTAMP")
    op.execute(
        "ALTER TABLE domains ADD COLUMN IF NOT EXISTS provision_attempts INTEGER NOT NULL DEFAULT 0"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE domains DROP COLUMN IF EXISTS provision_requested_at")
    op.execute("ALTER TABLE domains DROP COLUMN IF EXISTS provision_attempts")
