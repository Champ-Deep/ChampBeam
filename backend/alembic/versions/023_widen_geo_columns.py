"""Widen click_events geo columns to match the model.

On long-lived databases ``click_events.country`` was still VARCHAR(2) from an
early schema where it held an ISO code. The geo enrichment writes the full
country NAME ("United States"), so every enrichment UPDATE failed with
StringDataRightTruncationError and silently left all events without geo data —
the redirect itself still worked, so nothing surfaced except backend logs.

Fresh databases never hit this: ``Base.metadata.create_all()`` builds the column
from the model at VARCHAR(100). This migration brings existing databases in
line. Widening a varchar does not rewrite the table.

Revision ID: 023_widen_geo_columns
Revises: 022_domain_provisioning
"""

from alembic import op


revision = "023_widen_geo_columns"
down_revision = "022_domain_provisioning"
branch_labels = None
depends_on = None

# column -> model-declared length (app/models/utm.py ClickEvent)
_GEO_COLUMNS = {
    "country": 100,
    "region": 100,
    "city": 100,
    "asn_org": 255,
}


def upgrade() -> None:
    for column, length in _GEO_COLUMNS.items():
        # Only widen: never shrink a column that is already large enough, and
        # skip anything already correct so re-runs are free.
        op.execute(
            f"""
            DO $$
            DECLARE current_len integer;
            BEGIN
                SELECT character_maximum_length INTO current_len
                FROM information_schema.columns
                WHERE table_name = 'click_events' AND column_name = '{column}';

                IF current_len IS NOT NULL AND current_len < {length} THEN
                    ALTER TABLE click_events
                        ALTER COLUMN {column} TYPE VARCHAR({length});
                END IF;
            END $$;
            """
        )


def downgrade() -> None:
    # Deliberately not reversible: narrowing these would truncate real geo data.
    pass
