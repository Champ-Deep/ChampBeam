"""Intranet P2: optional access code on release (REL-7).

Revision ID: 033_intranet_p2
Revises: 032_intranet_p1
"""

from alembic import op

revision = "033_intranet_p2"
down_revision = "032_intranet_p1"
branch_labels = None
depends_on = None

_TRANSFER_COLUMNS = (
    ("access_code_hash", "VARCHAR(64)"),
    ("access_code_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("access_code_window_at", "TIMESTAMP"),
)


def upgrade() -> None:
    for name, ddl in _TRANSFER_COLUMNS:
        op.execute(f"ALTER TABLE transfers ADD COLUMN IF NOT EXISTS {name} {ddl}")


def downgrade() -> None:
    for name, _ in reversed(_TRANSFER_COLUMNS):
        op.execute(f"ALTER TABLE transfers DROP COLUMN IF EXISTS {name}")
