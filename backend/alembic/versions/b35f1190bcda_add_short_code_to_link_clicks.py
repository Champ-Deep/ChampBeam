"""Add short_code to link_clicks (no-op shim)

Revision ID: b35f1190bcda
Revises: 005_add_asn_org
Create Date: 2024-03-20 12:00:00.000000

The short_code column on link_clicks was already added by migration
003_projects_clicks. This revision is retained as an empty placeholder so
existing alembic histories that reference it remain valid and the chain
stays linear.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b35f1190bcda'
down_revision = '005_add_asn_org'
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
