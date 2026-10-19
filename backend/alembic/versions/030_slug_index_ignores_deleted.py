"""Slug uniqueness must ignore deleted rows.

Migration 024 made the slug indexes unique over every row, but slug_taken() and
every delete path treat status='deleted' as free. A deleted file therefore kept
its slug locked: re-adding it gave 409 "slug already taken", and the page list's
slug backfill hit the same index and returned 500 ("No pages yet").

Revision ID: 030_slug_index_ignores_deleted
Revises: 029_merge_heads
"""

revision = "030_slug_index_ignores_deleted"
down_revision = "029_merge_heads"
branch_labels = None
depends_on = None

from alembic import op

_LIVE = "slug IS NOT NULL AND status <> 'deleted'"


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_file_assets_slug_per_domain")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_slug_global")
    op.execute(
        "CREATE UNIQUE INDEX idx_file_assets_slug_per_domain "
        f"ON file_assets (domain_id, slug) WHERE domain_id IS NOT NULL AND {_LIVE}"
    )
    op.execute(
        "CREATE UNIQUE INDEX idx_file_assets_slug_global "
        f"ON file_assets (slug) WHERE domain_id IS NULL AND {_LIVE}"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_file_assets_slug_per_domain")
    op.execute("DROP INDEX IF EXISTS idx_file_assets_slug_global")
    op.execute(
        "CREATE UNIQUE INDEX idx_file_assets_slug_per_domain "
        "ON file_assets (domain_id, slug) WHERE domain_id IS NOT NULL AND slug IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX idx_file_assets_slug_global "
        "ON file_assets (slug) WHERE domain_id IS NULL AND slug IS NOT NULL"
    )
