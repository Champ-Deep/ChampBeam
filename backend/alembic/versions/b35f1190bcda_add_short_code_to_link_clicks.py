"""Add short_code to link_clicks

Revision ID: b35f1190bcda
Revises: head
Create Date: 2024-03-20 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b35f1190bcda'
down_revision = '002_utm_tables'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('link_clicks', sa.Column('short_code', sa.String(length=50), nullable=True))
    op.create_index(op.f('ix_link_clicks_short_code'), 'link_clicks', ['short_code'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_link_clicks_short_code'), table_name='link_clicks')
    op.drop_column('link_clicks', 'short_code')
