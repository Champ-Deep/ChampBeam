"""Organization + membership mirror of Clerk Organizations.

Clerk is the source of truth for orgs, memberships, and roles; these tables
mirror that state locally so we can scope data (content library, analytics) by
``organization_id`` and join shares back to the member who created them without
a round-trip to Clerk on every query. Rows are kept in sync two ways:

- authoritatively, via the Clerk webhook (``organization.*`` /
  ``organizationMembership.*`` events), and
- lazily, by a best-effort upsert on the auth hot path from the org claims in
  the session token (so the feature still works before webhooks are wired).
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.postgres import Base


# Role tiers. Super admin (any role ending in "admin") sees the whole org; a
# leader sees only the reps assigned to them (OrganizationMembership.leader_user_id);
# a member (rep / account manager) sees only their own activity. The external
# leads/prospects a rep sends to are not app users — they're the open/click layer.
ROLE_ADMIN = "admin"
ROLE_SUPER_ADMIN = "super_admin"
ROLE_LEADER = "leader"
ROLE_MEMBER = "member"


class Organization(Base):
    """Local mirror of a Clerk Organization."""

    __tablename__ = "organizations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    # Clerk organization id (org_...); the join key against the session token.
    clerk_org_id = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    slug = Column(String(255), nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    memberships = relationship(
        "OrganizationMembership",
        back_populates="organization",
        cascade="all, delete-orphan",
    )


class OrganizationMembership(Base):
    """A user's membership + role within an organization (admin | member)."""

    __tablename__ = "organization_memberships"
    __table_args__ = (
        UniqueConstraint("organization_id", "user_id", name="uq_org_membership_org_user"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    organization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Normalized role with the Clerk "org:" prefix stripped: "super_admin" |
    # "admin" | "leader" | "member" (or any custom org role name).
    role = Column(String(32), nullable=False, default=ROLE_MEMBER)
    clerk_membership_id = Column(String(255), nullable=True, index=True)

    # The leader (a user in the same org) this member reports to. Set by a super
    # admin; scopes a leader's analytics to just their reps. NULL for unassigned
    # members and for leaders/admins themselves. App-managed (not from Clerk).
    leader_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    organization = relationship("Organization", back_populates="memberships")
    # Two FK paths to users (user_id, leader_user_id) — disambiguate the member.
    user = relationship("User", foreign_keys=[user_id], backref="org_memberships")

    @property
    def is_admin(self) -> bool:
        return (self.role or "").lower().endswith(ROLE_ADMIN)

    @property
    def is_leader(self) -> bool:
        return (self.role or "").lower() == ROLE_LEADER
