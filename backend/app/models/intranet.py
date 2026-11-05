from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    false,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.db.postgres import Base


STATE_SUBMITTED = "submitted"
STATE_IN_REVIEW = "in_review"
STATE_RELEASED = "released"
STATE_REJECTED = "rejected"
STATE_CONSUMED = "consumed"
STATE_EXPIRED = "expired"
STATE_REVOKED = "revoked"
STATE_WITHDRAWN = "withdrawn"
STATE_CHECK_FAILED = "check_failed"

PENDING_STATES = (STATE_SUBMITTED, STATE_IN_REVIEW)
REVOCABLE_STATES = (STATE_SUBMITTED, STATE_IN_REVIEW, STATE_RELEASED)

EVENT_SUBMITTED = "submitted"
EVENT_CHECK_FAILED = "check_failed"
EVENT_OPENED_FOR_REVIEW = "opened_for_review"
EVENT_OPENED_BY_SUBMITTER = "opened_by_submitter"
EVENT_APPROVED = "approved"
EVENT_REJECTED = "rejected"
EVENT_ESCALATED = "escalated"
EVENT_RELEASED = "released"
EVENT_OPENED_BY_RECIPIENT = "opened_by_recipient"
EVENT_CONSUMED = "consumed"
EVENT_EXPIRED = "expired"
EVENT_REVOKED = "revoked"
EVENT_WITHDRAWN = "withdrawn"
EVENT_INVITED = "member_invited"
EVENT_INVITE_REVOKED = "invite_revoked"
EVENT_INVITE_EXPIRED = "invite_expired"
EVENT_MEMBER_UPDATED = "member_updated"
EVENT_MEMBER_DEACTIVATED = "member_deactivated"
EVENT_MEMBER_REACTIVATED = "member_reactivated"
EVENT_SETTINGS_CHANGED = "settings_changed"

ACTOR_HUMAN = "human"
ACTOR_AGENT = "agent"
ACTOR_SYSTEM = "system"

AGENT_OFF = "off"
INPUT_METADATA_ONLY = "metadata_only"

_JSON = JSON().with_variant(JSONB(), "postgresql")


class Transfer(Base):
    __tablename__ = "transfers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_id = Column(
        UUID(as_uuid=True), ForeignKey("file_assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    submitter_user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    recipient_user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    purpose = Column(String(500), nullable=False)
    state = Column(String(20), nullable=False, default=STATE_SUBMITTED, index=True)

    requested_expires_in_days = Column(Integer, nullable=True)
    requested_one_time = Column(Boolean, nullable=False, default=False, server_default=false())
    one_time = Column(Boolean, nullable=False, default=False, server_default=false())
    expires_at = Column(DateTime, nullable=True, index=True)

    download_claim_token = Column(String(64), nullable=True)
    download_claim_at = Column(DateTime, nullable=True)

    check_results = Column(_JSON, nullable=True)

    submitted_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    agent_window_ends_at = Column(DateTime, nullable=True)
    hard_expires_at = Column(DateTime, nullable=True, index=True)
    decided_at = Column(DateTime, nullable=True)
    decided_by_type = Column(String(16), nullable=True)
    decided_by_id = Column(String(255), nullable=True)
    reject_reason = Column(Text, nullable=True)
    released_at = Column(DateTime, nullable=True)
    first_opened_at = Column(DateTime, nullable=True)
    consumed_at = Column(DateTime, nullable=True)
    expired_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    revoked_by_id = Column(String(255), nullable=True)
    withdrawn_at = Column(DateTime, nullable=True)


class DecisionLogEntry(Base):
    __tablename__ = "decision_log"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    organization_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    transfer_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    event = Column(String(40), nullable=False, index=True)
    actor_type = Column(String(16), nullable=False)
    actor_id = Column(String(255), nullable=True, index=True)
    reason = Column(Text, nullable=True)
    detail = Column(_JSON, nullable=True)
    agent_provider = Column(String(40), nullable=True)
    agent_model = Column(String(120), nullable=True)
    agent_input_mode = Column(String(20), nullable=True)
    agent_p_approve = Column(Float, nullable=True)
    agent_threshold = Column(Float, nullable=True)
    agent_input_sha256 = Column(String(64), nullable=True)
    prev_hash = Column(String(64), nullable=True)
    row_hash = Column(String(64), nullable=False)


class OrgReviewSettings(Base):
    __tablename__ = "org_review_settings"

    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    agent_mode = Column(String(16), nullable=False, default=AGENT_OFF)
    agent_window_hours = Column(Integer, nullable=False, default=24)
    agent_threshold = Column(Float, nullable=False, default=0.95)
    agent_input_mode = Column(String(20), nullable=False, default=INPUT_METADATA_ONLY)
    default_expiry_days = Column(Integer, nullable=False, default=7)
    hard_expiry_days = Column(Integer, nullable=False, default=7)
    reminder_hours = Column(Integer, nullable=True, default=12)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by_id = Column(String(255), nullable=True)


class OrgInvite(Base):
    __tablename__ = "org_invites"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email = Column(String(320), nullable=False, index=True)
    role = Column(String(32), nullable=False, default="member")
    clerk_invitation_id = Column(String(255), nullable=True, index=True)
    invited_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
