"""Merge the notification cursor and assistant config heads.

Both 027_notification_cursor (PR #38) and 027_pages_v2_link_aliases (PR #28)
revise 026_maxmind_usage. This empty merge revision joins them so the chain has
one head again.

Revision ID: 029_merge_heads
Revises: 027_notification_cursor, 028_assistant_config
"""

revision = "029_merge_heads"
down_revision = ("027_notification_cursor", "028_assistant_config")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
