"""Clerk webhook receiver: keeps the local user + org mirror authoritative.

Clerk POSTs svix-signed events here. We handle the user and organization
lifecycle so the local ``users`` / ``organizations`` /
``organization_memberships`` tables track Clerk without depending on the lazy
on-auth sync. Configure CLERK_WEBHOOK_SECRET and point a Clerk webhook at
``/api/v1/webhooks/clerk`` with the user.* and organization* event filters.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from app.core.config import settings
from app.db.postgres import async_session_maker
from app.models.org import Organization, OrganizationMembership
from app.models.user import User
from app.services import clerk_client, org_service
from app.services.user_service import user_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["Webhooks"])


@router.post("/clerk")
async def clerk_webhook(request: Request) -> dict[str, Any]:
    if not settings.clerk_webhook_configured:
        raise HTTPException(
            status_code=503,
            detail="Clerk webhooks are not configured (set CLERK_WEBHOOK_SECRET).",
        )

    body = await request.body()
    if not clerk_client.verify_webhook(dict(request.headers), body):
        raise HTTPException(status_code=401, detail="Invalid webhook signature.")

    event = await request.json()
    event_type = event.get("type", "")
    data = event.get("data", {}) or {}
    logger.info("clerk webhook: %s", event_type)

    try:
        async with async_session_maker() as session:
            await _dispatch(session, event_type, data)
            await session.commit()
    except Exception:
        logger.exception("clerk webhook handler failed for %s", event_type)
        # 200 so Clerk doesn't hammer retries on a non-transient bug; the lazy
        # on-auth sync remains a backstop.
        return {"ok": False, "handled": event_type}

    return {"ok": True, "handled": event_type}


async def _dispatch(session, event_type: str, data: dict[str, Any]) -> None:
    if event_type in ("user.created", "user.updated"):
        await _handle_user_upsert(session, data)
    elif event_type == "user.deleted":
        await _handle_user_deleted(session, data)
    elif event_type in ("organization.created", "organization.updated"):
        await org_service.upsert_organization(
            session, data["id"], name=data.get("name"), slug=data.get("slug")
        )
    elif event_type == "organization.deleted":
        await _delete_organization(session, data.get("id"))
    elif event_type in (
        "organizationMembership.created",
        "organizationMembership.updated",
    ):
        await _handle_membership_upsert(session, data)
    elif event_type == "organizationMembership.deleted":
        await _handle_membership_deleted(session, data)


async def _handle_user_upsert(session, data: dict[str, Any]) -> None:
    clerk_id = data.get("id")
    if not clerk_id:
        return
    user = await user_service.get_or_create_by_clerk_id(session, clerk_id)
    await user_service.apply_identity(
        session,
        user,
        email=clerk_client.primary_email(data),
        full_name=clerk_client.full_name(data),
    )


async def _handle_user_deleted(session, data: dict[str, Any]) -> None:
    clerk_id = data.get("id")
    if not clerk_id:
        return
    result = await session.execute(select(User).where(User.clerk_id == clerk_id))
    user = result.scalar_one_or_none()
    if user:
        # Soft-deactivate; keep the row so historical analytics/attribution hold.
        user.is_active = False


async def _delete_organization(session, clerk_org_id: str | None) -> None:
    if not clerk_org_id:
        return
    result = await session.execute(
        select(Organization).where(Organization.clerk_org_id == clerk_org_id)
    )
    org = result.scalar_one_or_none()
    if org:
        await session.delete(org)


async def _handle_membership_upsert(session, data: dict[str, Any]) -> None:
    org_data = data.get("organization") or {}
    user_data = data.get("public_user_data") or {}
    clerk_org_id = org_data.get("id")
    clerk_user_id = user_data.get("user_id")
    if not (clerk_org_id and clerk_user_id):
        return
    org = await org_service.upsert_organization(
        session, clerk_org_id, name=org_data.get("name"), slug=org_data.get("slug")
    )
    user = await user_service.get_or_create_by_clerk_id(session, clerk_user_id)
    # Backfill identity from the embedded public_user_data when present.
    email = user_data.get("identifier")
    name = " ".join(
        p for p in [user_data.get("first_name"), user_data.get("last_name")] if p
    ).strip() or None
    await user_service.apply_identity(session, user, email=email, full_name=name)
    await org_service.upsert_membership(
        session,
        org.id,
        user.id,
        org_service.normalize_role(data.get("role")),
        clerk_membership_id=data.get("id"),
    )


async def _handle_membership_deleted(session, data: dict[str, Any]) -> None:
    org_data = data.get("organization") or {}
    user_data = data.get("public_user_data") or {}
    clerk_org_id = org_data.get("id")
    clerk_user_id = user_data.get("user_id")
    if not (clerk_org_id and clerk_user_id):
        return
    result = await session.execute(
        select(OrganizationMembership)
        .join(Organization, OrganizationMembership.organization_id == Organization.id)
        .join(User, OrganizationMembership.user_id == User.id)
        .where(Organization.clerk_org_id == clerk_org_id, User.clerk_id == clerk_user_id)
    )
    membership = result.scalar_one_or_none()
    if membership:
        await session.delete(membership)
