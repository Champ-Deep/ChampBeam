"""Add is_shared to utm_presets

Revision ID: 52f5b4d7d10e
Revises: b35f1190bcda
Create Date: 2024-03-20 12:05:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '52f5b4d7d10e'
down_revision = 'b35f1190bcda'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('utm_presets', sa.Column('is_shared', sa.Boolean(), server_default='false', nullable=True))


def downgrade() -> None:
    op.drop_column('utm_presets', 'is_shared')
