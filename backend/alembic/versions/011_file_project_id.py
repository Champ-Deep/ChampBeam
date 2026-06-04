"""Add project_id to file_assets (folders for files).

Lets files be organized into projects, mirroring LinkClick.project_id.
Idempotent via IF NOT EXISTS guards, in the same defensive style as 009/010.

Revision ID: 011_file_project_id
Revises: 010_anon_expiring_files
"""

from alembic import op


revision = "011_file_project_id"
down_revision = "010_anon_expiring_files"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS project_id UUID "
        "REFERENCES projects(id) ON DELETE SET NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_assets_project_id "
        "ON file_assets (project_id) WHERE project_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_file_assets_project_id")
    op.execute("ALTER TABLE file_assets DROP COLUMN IF EXISTS project_id")
