"""Intranet: review-gated transfers, append-only decision log, review settings, invites.

Revision ID: 031_intranet_transfers
Revises: 030_slug_index_ignores_deleted
"""

from alembic import op

revision = "031_intranet_transfers"
down_revision = "030_slug_index_ignores_deleted"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE organization_memberships "
        "ADD COLUMN IF NOT EXISTS is_reviewer BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute("ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS transfers (
            id UUID PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            file_id UUID NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
            submitter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            purpose VARCHAR(500) NOT NULL,
            state VARCHAR(20) NOT NULL DEFAULT 'submitted',
            requested_expires_in_days INTEGER,
            requested_one_time BOOLEAN NOT NULL DEFAULT false,
            one_time BOOLEAN NOT NULL DEFAULT false,
            expires_at TIMESTAMP,
            download_claim_token VARCHAR(64),
            download_claim_at TIMESTAMP,
            check_results JSONB,
            submitted_at TIMESTAMP NOT NULL,
            agent_window_ends_at TIMESTAMP,
            hard_expires_at TIMESTAMP,
            decided_at TIMESTAMP,
            decided_by_type VARCHAR(16),
            decided_by_id VARCHAR(255),
            reject_reason TEXT,
            released_at TIMESTAMP,
            first_opened_at TIMESTAMP,
            consumed_at TIMESTAMP,
            expired_at TIMESTAMP,
            revoked_at TIMESTAMP,
            revoked_by_id VARCHAR(255),
            withdrawn_at TIMESTAMP
        )
        """
    )
    for col in ("organization_id", "file_id", "submitter_user_id", "recipient_user_id", "state", "expires_at", "hard_expires_at"):
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_transfers_{col} ON transfers ({col})")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS decision_log (
            id BIGSERIAL PRIMARY KEY,
            at TIMESTAMP NOT NULL,
            organization_id UUID NOT NULL,
            transfer_id UUID,
            event VARCHAR(40) NOT NULL,
            actor_type VARCHAR(16) NOT NULL,
            actor_id VARCHAR(255),
            reason TEXT,
            detail JSONB,
            agent_provider VARCHAR(40),
            agent_model VARCHAR(120),
            agent_input_mode VARCHAR(20),
            agent_p_approve DOUBLE PRECISION,
            agent_threshold DOUBLE PRECISION,
            agent_input_sha256 VARCHAR(64),
            prev_hash VARCHAR(64),
            row_hash VARCHAR(64) NOT NULL
        )
        """
    )
    for col in ("at", "organization_id", "transfer_id", "event", "actor_id"):
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_decision_log_{col} ON decision_log ({col})")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION decision_log_append_only() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'decision_log is append-only';
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute("DROP TRIGGER IF EXISTS decision_log_no_update ON decision_log")
    op.execute(
        "CREATE TRIGGER decision_log_no_update BEFORE UPDATE OR DELETE ON decision_log "
        "FOR EACH ROW EXECUTE FUNCTION decision_log_append_only()"
    )
    op.execute("DROP TRIGGER IF EXISTS decision_log_no_truncate ON decision_log")
    op.execute(
        "CREATE TRIGGER decision_log_no_truncate BEFORE TRUNCATE ON decision_log "
        "FOR EACH STATEMENT EXECUTE FUNCTION decision_log_append_only()"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_review_settings (
            organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
            agent_mode VARCHAR(16) NOT NULL DEFAULT 'off',
            agent_window_hours INTEGER NOT NULL DEFAULT 24,
            agent_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.95,
            agent_input_mode VARCHAR(20) NOT NULL DEFAULT 'metadata_only',
            default_expiry_days INTEGER NOT NULL DEFAULT 7,
            hard_expiry_days INTEGER NOT NULL DEFAULT 7,
            reminder_hours INTEGER DEFAULT 12,
            updated_at TIMESTAMP,
            updated_by_id VARCHAR(255)
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_invites (
            id UUID PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            email VARCHAR(320) NOT NULL,
            role VARCHAR(32) NOT NULL DEFAULT 'member',
            clerk_invitation_id VARCHAR(255),
            invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            revoked_at TIMESTAMP
        )
        """
    )
    for col in ("organization_id", "email", "clerk_invitation_id"):
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_org_invites_{col} ON org_invites ({col})")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS org_invites")
    op.execute("DROP TABLE IF EXISTS org_review_settings")
    op.execute("DROP TRIGGER IF EXISTS decision_log_no_truncate ON decision_log")
    op.execute("DROP TRIGGER IF EXISTS decision_log_no_update ON decision_log")
    op.execute("DROP TABLE IF EXISTS decision_log")
    op.execute("DROP FUNCTION IF EXISTS decision_log_append_only()")
    op.execute("DROP TABLE IF EXISTS transfers")
    op.execute("ALTER TABLE organization_memberships DROP COLUMN IF EXISTS deactivated_at")
    op.execute("ALTER TABLE organization_memberships DROP COLUMN IF EXISTS is_reviewer")
