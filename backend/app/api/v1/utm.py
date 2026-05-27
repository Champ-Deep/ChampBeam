"""
UTM API endpoints for ChampUTM.

Preset CRUD, link generation, bulk CSV processing, and analytics.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Request
from fastapi.responses import StreamingResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import TokenData, require_auth, get_current_user
from app.db.postgres import get_db_session
from app.models.utm import ClickEvent, LinkClick, UTMPreset
from app.services.utm_service import utm_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/utm", tags=["UTM"])


# ============================================================================
# Request / Response Models
# ============================================================================


class UTMPresetCreate(BaseModel):
    name: str
    is_shared: bool = False
    utm_source: str = ""
    utm_medium: str = ""
    utm_campaign: str = ""
    utm_content: Optional[str] = None
    utm_term: Optional[str] = None
    custom_params: Optional[dict] = None


class UTMPresetUpdate(BaseModel):
    name: Optional[str] = None
    is_shared: Optional[bool] = None
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None
    utm_campaign: Optional[str] = None
    utm_content: Optional[str] = None
    utm_term: Optional[str] = None
    custom_params: Optional[dict] = None


class UTMPresetResponse(BaseModel):
    id: str
    user_id: str
    name: str
    is_default: bool = False
    is_shared: bool = False
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None
    utm_campaign: Optional[str] = None
    utm_content: Optional[str] = None
    utm_term: Optional[str] = None
    custom_params: Optional[dict] = None
    created_at: str


class GenerateLinkRequest(BaseModel):
    base_url: str
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None
    utm_campaign: Optional[str] = None
    utm_content: Optional[str] = None
    utm_term: Optional[str] = None
    project_name: Optional[str] = None
    project_id: Optional[str] = None
    preset_id: Optional[str] = None


class GenerateLinkResponse(BaseModel):
    original_url: str
    tracked_url: str
    redirect_url: Optional[str] = None
    short_code: Optional[str] = None
    utm_params: dict
    link_id: Optional[str] = None
    short_url: Optional[str] = None


class UTMBreakdownItem(BaseModel):
    group_key: str
    group_value: str
    total_links: int
    total_clicks: int
    unique_clicks: int
    click_rate: float


class LinkPerformanceItem(BaseModel):
    link_id: str
    original_url: str
    tracked_url: Optional[str] = None
    redirect_url: Optional[str] = None
    short_code: Optional[str] = None
    anchor_text: Optional[str] = None
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None
    utm_campaign: Optional[str] = None
    utm_content: Optional[str] = None
    utm_term: Optional[str] = None
    project_name: Optional[str] = None
    project_id: Optional[str] = None
    click_count: int = 0
    unique_clicks: int = 0
    first_clicked_at: Optional[str] = None
    created_at: Optional[str] = None


class UTMOverviewResponse(BaseModel):
    total_tracked_links: int = 0
    total_clicks: int = 0
    unique_clicks: int = 0
    overall_click_rate: float = 0.0
    top_sources: list = []
    top_campaigns: list = []


# ============================================================================
# Helpers
# ============================================================================


def _build_redirect_url(short_code: str | None, request: Request | None = None) -> str | None:
    """Build a full redirect URL from a short code.

    Prefers ``request.base_url`` so the URL always matches the host the
    client used. Falls back to ``settings.redirect_base_url`` when an
    explicit override is configured (useful behind a reverse proxy that
    rewrites Host).
    """
    if not short_code:
        return None
    override = settings.redirect_base_url.rstrip("/") if settings.redirect_base_url else ""
    if override:
        base = override
    elif request is not None:
        base = str(request.base_url).rstrip("/")
    else:
        base = ""
    return f"{base}/r/{short_code}"


def _resolve_date_range(
    days: int = 30,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> tuple[datetime, datetime]:
    """Resolve a date range from either explicit dates or a days-back count.

    Returns (start_datetime, end_datetime).
    """
    now = datetime.utcnow()
    if start_date and end_date:
        try:
            start = datetime.fromisoformat(start_date)
            end = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format. Use ISO 8601 (YYYY-MM-DD).")
        if start > end:
            raise HTTPException(status_code=400, detail="start_date must be before end_date.")
        return start, end
    return now - timedelta(days=days), now


def _to_uuid(value: Optional[str]):
    """Convert a string to UUID for safe comparison with UUID columns."""
    if not value:
        return None
    from uuid import UUID as _UUID
    try:
        return _UUID(value)
    except ValueError:
        return None


def _preset_to_response(preset: UTMPreset) -> dict:
    return {
        "id": str(preset.id),
        "user_id": str(preset.user_id),
        "name": preset.name,
        "is_default": preset.is_default or False,
        "is_shared": preset.is_shared or False,
        "utm_source": preset.utm_source,
        "utm_medium": preset.utm_medium,
        "utm_campaign": preset.utm_campaign,
        "utm_content": preset.utm_content,
        "utm_term": preset.utm_term,
        "custom_params": preset.custom_params,
        "created_at": preset.created_at.isoformat() if preset.created_at else "",
    }


# ============================================================================
# Link Generation (public endpoint — auth optional)
# ============================================================================


@router.post("/generate", response_model=GenerateLinkResponse)
async def generate_utm_link(
    request: Request,
    data: GenerateLinkRequest,
    user: TokenData | None = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Generate a single UTM-tagged URL.

    Works without authentication for public use.
    Authenticated users can use preset_id and get links tracked.
    """
    utm_params: dict = {}

    # If preset_id provided, load preset values as base
    if data.preset_id and user:
        result = await session.execute(
            select(UTMPreset).where(
                UTMPreset.id == data.preset_id,
                UTMPreset.user_id == user.user_id,
            )
        )
        preset = result.scalar_one_or_none()
        if preset:
            for key in ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"):
                val = getattr(preset, key)
                if val:
                    utm_params[key] = val

    # Request-level params override preset
    for key in ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"):
        val = getattr(data, key, None)
        if val:
            utm_params[key] = val

    tracked_url = utm_service.generate_utm_url(data.base_url, utm_params)

    # Record link for authenticated users
    link_id = None
    short_code = None
    redirect_url = None
    short_url = None
    if user:
        from uuid import UUID as _UUID
        project_id = _UUID(data.project_id) if data.project_id else None
        link = await utm_service.record_link(
            user_id=user.user_id,
            original_url=data.base_url,
            tracked_url=tracked_url,
            utm_params=utm_params,
            project_name=data.project_name,
            project_id=project_id,
            session=session,
        )
        link_id = str(link.id)
        short_code = link.short_code
        redirect_url = _build_redirect_url(link.short_code, request)
        if link.short_code:
            # The short URL is handled by the backend routing directly (/s/{short_code})
            # Use request.base_url to construct the absolute URL.
            short_url = str(request.base_url) + f"s/{link.short_code}"

    return GenerateLinkResponse(
        original_url=data.base_url,
        tracked_url=tracked_url,
        redirect_url=redirect_url,
        short_code=short_code,
        utm_params=utm_params,
        link_id=link_id,
        short_url=short_url,
    )


# ============================================================================
# Link Management (auth required)
# ============================================================================


class UpdateLinkRequest(BaseModel):
    project_id: Optional[str] = None


@router.delete("/links/{link_id}", status_code=204)
async def delete_link(
    link_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a tracked link and all its click events."""
    from uuid import UUID as _UUID

    try:
        uid = _UUID(link_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid link ID.")

    result = await session.execute(
        select(LinkClick).where(LinkClick.id == uid, LinkClick.user_id == user.user_id)
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found.")

    # Delete associated click events first
    await session.execute(sa_delete(ClickEvent).where(ClickEvent.link_id == uid))
    await session.delete(link)
    await session.commit()


@router.patch("/links/{link_id}")
async def update_link(
    link_id: str,
    data: UpdateLinkRequest,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a tracked link (e.g., reassign to a different project)."""
    from uuid import UUID as _UUID

    try:
        uid = _UUID(link_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid link ID.")

    result = await session.execute(
        select(LinkClick).where(LinkClick.id == uid, LinkClick.user_id == user.user_id)
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found.")

    if data.project_id is not None:
        link.project_id = _UUID(data.project_id) if data.project_id else None

    await session.commit()
    await session.refresh(link)

    return {
        "id": str(link.id),
        "project_id": str(link.project_id) if link.project_id else None,
        "original_url": link.original_url,
        "short_code": link.short_code,
    }


# ============================================================================
# Bulk CSV Processing (auth required)
# ============================================================================


@router.post("/bulk/generate")
async def generate_bulk_utm_links(
    request: Request,
    file: UploadFile = File(...),
    preset_id: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Process a CSV of URLs and append UTM parameters.

    CSV must have a 'url' column. Can optionally include utm_source,
    utm_medium, etc. columns to override per row. Every row is persisted
    as a trackable short link so the resulting URLs can be sent out and
    measured via per-link analytics.
    """
    if not file.filename or not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a CSV")

    content = await file.read()
    csv_content = content.decode("utf-8")

    # Build default params from preset if provided
    default_params: dict = {}
    if preset_id:
        result = await session.execute(
            select(UTMPreset).where(
                UTMPreset.id == preset_id,
                UTMPreset.user_id == user.user_id,
            )
        )
        preset = result.scalar_one_or_none()
        if preset:
            for key in ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"):
                val = getattr(preset, key)
                if val:
                    default_params[key] = val

    try:
        result_csv = await utm_service.process_bulk_csv(
            csv_content,
            default_params,
            user_id=user.user_id,
            session=session,
            short_link_builder=lambda code: _build_redirect_url(code, request),
        )
        await session.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    import io
    return StreamingResponse(
        io.BytesIO(result_csv.encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=utm_links.csv"},
    )


@router.get("/bulk/template")
async def download_csv_template():
    """Download a CSV template for bulk UTM generation."""
    template = "url,utm_source,utm_medium,utm_campaign,utm_content,utm_term\nhttps://example.com,google,cpc,summer-sale,,\n"

    import io
    return StreamingResponse(
        io.BytesIO(template.encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=utm_template.csv"},
    )


# ============================================================================
# Preset Endpoints (auth required)
# ============================================================================


from sqlalchemy import or_

@router.get("/presets", response_model=List[UTMPresetResponse])
async def list_presets(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List all UTM presets for the authenticated user and shared presets."""
    result = await session.execute(
        select(UTMPreset)
        .where(
            or_(
                UTMPreset.user_id == user.user_id,
                UTMPreset.is_shared == True
            )
        )
        .order_by(UTMPreset.created_at.desc())
    )
    presets = result.scalars().all()
    return [_preset_to_response(p) for p in presets]


@router.post("/presets", response_model=UTMPresetResponse, status_code=201)
async def create_preset(
    data: UTMPresetCreate,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new UTM preset."""
    from uuid import uuid4

    preset = UTMPreset(
        id=uuid4(),
        user_id=user.user_id,
        name=data.name,
        is_shared=data.is_shared,
        utm_source=data.utm_source,
        utm_medium=data.utm_medium,
        utm_campaign=data.utm_campaign,
        utm_content=data.utm_content,
        utm_term=data.utm_term,
        custom_params=data.custom_params,
    )
    session.add(preset)
    await session.flush()

    return _preset_to_response(preset)


@router.get("/presets/{preset_id}", response_model=UTMPresetResponse)
async def get_preset(
    preset_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a specific UTM preset."""
    result = await session.execute(
        select(UTMPreset).where(
            UTMPreset.id == preset_id,
            UTMPreset.user_id == user.user_id,
        )
    )
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(status_code=404, detail="UTM preset not found")
    return _preset_to_response(preset)


@router.put("/presets/{preset_id}", response_model=UTMPresetResponse)
async def update_preset(
    preset_id: str,
    data: UTMPresetUpdate,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a UTM preset."""
    result = await session.execute(
        select(UTMPreset).where(
            UTMPreset.id == preset_id,
            UTMPreset.user_id == user.user_id,
        )
    )
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(status_code=404, detail="UTM preset not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(preset, field, value)
    preset.updated_at = datetime.utcnow()

    await session.flush()
    return _preset_to_response(preset)


@router.delete("/presets/{preset_id}", status_code=204)
async def delete_preset(
    preset_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a UTM preset."""
    result = await session.execute(
        select(UTMPreset).where(
            UTMPreset.id == preset_id,
            UTMPreset.user_id == user.user_id,
        )
    )
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(status_code=404, detail="UTM preset not found")

    await session.delete(preset)
    await session.flush()


@router.post("/presets/{preset_id}/default", response_model=UTMPresetResponse)
async def set_default_preset(
    preset_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Set a preset as the user's default."""
    result = await session.execute(
        select(UTMPreset).where(
            UTMPreset.id == preset_id,
            UTMPreset.user_id == user.user_id,
        )
    )
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(status_code=404, detail="UTM preset not found")

    # Clear is_default on all user's presets
    await session.execute(
        update(UTMPreset)
        .where(UTMPreset.user_id == user.user_id)
        .values(is_default=False)
    )

    preset.is_default = True
    preset.updated_at = datetime.utcnow()
    await session.flush()

    return _preset_to_response(preset)


# ============================================================================
# Analytics Endpoints (auth required)
# ============================================================================


@router.get("/analytics/overview", response_model=UTMOverviewResponse)
async def get_utm_overview(
    project_id: Optional[str] = Query(default=None, description="Filter by project ID"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """UTM analytics overview: total tracked links, clicks, top sources/campaigns."""
    base_conds = [LinkClick.user_id == user.user_id]
    if project_id:
        base_conds.append(LinkClick.project_id == _to_uuid(project_id))

    agg = await session.execute(
        select(
            func.count(LinkClick.id).label("total_links"),
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
        )
        .where(*base_conds)
    )
    row = agg.one()
    total_links = row.total_links or 0
    total_clicks = int(row.total_clicks) if row.total_clicks else 0
    unique_clicks = int(row.unique_clicks) if row.unique_clicks else 0
    overall_click_rate = round((unique_clicks / total_links * 100) if total_links > 0 else 0.0, 2)

    # Top 5 sources
    source_result = await session.execute(
        select(
            LinkClick.utm_source,
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
        )
        .where(*base_conds, LinkClick.utm_source.isnot(None))
        .group_by(LinkClick.utm_source)
        .order_by(func.sum(LinkClick.click_count).desc())
        .limit(5)
    )
    top_sources = [
        {"source": r.utm_source, "clicks": int(r.total_clicks)}
        for r in source_result.all()
    ]

    # Top 5 campaigns
    campaign_result = await session.execute(
        select(
            LinkClick.utm_campaign,
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
        )
        .where(*base_conds, LinkClick.utm_campaign.isnot(None))
        .group_by(LinkClick.utm_campaign)
        .order_by(func.sum(LinkClick.click_count).desc())
        .limit(5)
    )
    top_campaigns = [
        {"campaign": r.utm_campaign, "clicks": int(r.total_clicks)}
        for r in campaign_result.all()
    ]

    overview = UTMOverviewResponse(
        total_tracked_links=total_links,
        total_clicks=total_clicks,
        unique_clicks=unique_clicks,
        overall_click_rate=overall_click_rate,
        top_sources=top_sources,
        top_campaigns=top_campaigns,
    )

    return overview


@router.get("/analytics/breakdown", response_model=List[UTMBreakdownItem])
async def get_utm_breakdown(
    group_by: str = Query(
        default="source",
        description="UTM field to group by: source, medium, campaign, content, term",
    ),
    project_name: Optional[str] = Query(default=None, description="Filter by project name"),
    project_id: Optional[str] = Query(default=None, description="Filter by project ID"),
    days: int = Query(default=30, ge=1, le=365, description="Days to look back"),
    start_date: Optional[str] = Query(default=None, description="Start date (ISO 8601)"),
    end_date: Optional[str] = Query(default=None, description="End date (ISO 8601)"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Flexible UTM breakdown by any UTM field, optionally filtered by project and time range."""
    column_map = {
        "source": LinkClick.utm_source,
        "medium": LinkClick.utm_medium,
        "campaign": LinkClick.utm_campaign,
        "content": LinkClick.utm_content,
        "term": LinkClick.utm_term,
    }

    column = column_map.get(group_by)
    if not column:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid group_by '{group_by}'. Must be: source, medium, campaign, content, term",
        )

    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= range_start,
        LinkClick.created_at <= range_end,
        column.isnot(None),
    ]
    if project_id:
        conditions.append(LinkClick.project_id == _to_uuid(project_id))
    elif project_name:
        conditions.append(LinkClick.project_name == project_name)

    result = await session.execute(
        select(
            column.label("group_value"),
            func.count(LinkClick.id).label("total_links"),
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
        )
        .where(*conditions)
        .group_by(column)
        .order_by(func.sum(LinkClick.click_count).desc())
    )

    items = []
    for row in result.all():
        total_links = row.total_links or 0
        unique = int(row.unique_clicks) if row.unique_clicks else 0
        items.append(UTMBreakdownItem(
            group_key=group_by,
            group_value=row.group_value,
            total_links=total_links,
            total_clicks=int(row.total_clicks) if row.total_clicks else 0,
            unique_clicks=unique,
            click_rate=round((unique / total_links * 100) if total_links > 0 else 0.0, 2),
        ))

    return items


@router.get("/analytics/links", response_model=List[LinkPerformanceItem])
async def get_link_performance(
    request: Request,
    project_name: Optional[str] = Query(default=None, description="Filter by project name"),
    project_id: Optional[str] = Query(default=None, description="Filter by project ID"),
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None, description="Start date (ISO 8601)"),
    end_date: Optional[str] = Query(default=None, description="End date (ISO 8601)"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List all tracked links with click stats, ordered by click_count desc."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= range_start,
        LinkClick.created_at <= range_end,
    ]
    if project_id:
        conditions.append(LinkClick.project_id == _to_uuid(project_id))
    elif project_name:
        conditions.append(LinkClick.project_name == project_name)

    result = await session.execute(
        select(LinkClick)
        .where(*conditions)
        .order_by(LinkClick.click_count.desc(), LinkClick.created_at.desc())
        .limit(200)
    )

    items = []
    for link in result.scalars().all():
        items.append(LinkPerformanceItem(
            link_id=str(link.id),
            original_url=link.original_url,
            tracked_url=link.tracked_url,
            redirect_url=_build_redirect_url(link.short_code, request),
            short_code=link.short_code,
            anchor_text=link.anchor_text,
            utm_source=link.utm_source,
            utm_medium=link.utm_medium,
            utm_campaign=link.utm_campaign,
            utm_content=link.utm_content,
            utm_term=link.utm_term,
            project_name=link.project_name,
            project_id=str(link.project_id) if link.project_id else None,
            click_count=link.click_count or 0,
            unique_clicks=link.unique_clicks or 0,
            first_clicked_at=link.first_clicked_at.isoformat() if link.first_clicked_at else None,
            created_at=link.created_at.isoformat() if link.created_at else None,
        ))

    return items


@router.get("/analytics/performance")
async def get_performance_over_time(
    days: int = Query(default=30, ge=1, le=365),
    project_name: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    start_date: Optional[str] = Query(default=None, description="Start date (ISO 8601)"),
    end_date: Optional[str] = Query(default=None, description="End date (ISO 8601)"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get link generation and click counts over time (daily buckets)."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= range_start,
        LinkClick.created_at <= range_end,
    ]
    if project_id:
        conditions.append(LinkClick.project_id == _to_uuid(project_id))
    elif project_name:
        conditions.append(LinkClick.project_name == project_name)

    result = await session.execute(
        select(
            func.date_trunc("day", LinkClick.created_at).label("date"),
            func.count(LinkClick.id).label("links_created"),
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
        )
        .where(*conditions)
        .group_by(func.date_trunc("day", LinkClick.created_at))
        .order_by(func.date_trunc("day", LinkClick.created_at))
    )

    data = []
    for row in result.all():
        data.append({
            "date": row.date.isoformat() if row.date else None,
            "links_created": row.links_created or 0,
            "total_clicks": int(row.total_clicks) if row.total_clicks else 0,
            "unique_clicks": int(row.unique_clicks) if row.unique_clicks else 0,
        })

    return {"days": days, "data": data}


# ============================================================================
# Per-Link Analytics Endpoints (auth required)
# ============================================================================


async def _get_user_link(
    link_id: str, user_id: str, session: AsyncSession,
) -> LinkClick:
    """Fetch a link and verify ownership. Raises 404 if not found."""
    result = await session.execute(
        select(LinkClick).where(
            LinkClick.id == link_id,
            LinkClick.user_id == user_id,
        )
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    return link


@router.get("/analytics/links/{link_id}/events")
async def get_link_click_events(
    link_id: str,
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None, description="Start date (ISO 8601)"),
    end_date: Optional[str] = Query(default=None, description="End date (ISO 8601)"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get individual click events for a specific link."""
    await _get_user_link(link_id, user.user_id, session)

    range_start, range_end = _resolve_date_range(days, start_date, end_date)
    events = await session.execute(
        select(ClickEvent)
        .where(
            ClickEvent.link_id == link_id,
            ClickEvent.clicked_at >= range_start,
            ClickEvent.clicked_at <= range_end,
        )
        .order_by(ClickEvent.clicked_at.desc())
        .limit(500)
    )
    return [
        {
            "id": str(e.id),
            "ip_address": e.ip_address,
            "device_type": e.device_type,
            "browser": e.browser,
            "os": e.os,
            "country": e.country,
            "country_code": e.country_code,
            "region": e.region,
            "city": e.city,
            "referrer": e.referrer,
            "is_vpn": e.is_vpn or False,
            "asn_org": e.asn_org,
            "clicked_at": e.clicked_at.isoformat() if e.clicked_at else None,
        }
        for e in events.scalars().all()
    ]


@router.get("/analytics/links/{link_id}/geo")
async def get_link_geo_breakdown(
    link_id: str,
    level: str = Query(default="country", description="Geo level: country, region, city"),
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None, description="Start date (ISO 8601)"),
    end_date: Optional[str] = Query(default=None, description="End date (ISO 8601)"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get geographic breakdown of clicks for a specific link."""
    await _get_user_link(link_id, user.user_id, session)

    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    if level == "region":
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                ClickEvent.region,
                func.count(ClickEvent.id).label("clicks"),
            )
            .where(
                ClickEvent.link_id == link_id,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [
            {"country": r.country, "country_code": r.country_code, "region": r.region, "clicks": r.clicks}
            for r in result.all()
        ]
    elif level == "city":
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                ClickEvent.region,
                ClickEvent.city,
                func.count(ClickEvent.id).label("clicks"),
            )
            .where(
                ClickEvent.link_id == link_id,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region, ClickEvent.city)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [
            {"country": r.country, "country_code": r.country_code, "region": r.region, "city": r.city, "clicks": r.clicks}
            for r in result.all()
        ]
    else:
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                func.count(ClickEvent.id).label("clicks"),
            )
            .where(
                ClickEvent.link_id == link_id,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.country, ClickEvent.country_code)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [
            {"country": r.country, "country_code": r.country_code, "clicks": r.clicks}
            for r in result.all()
        ]


@router.get("/analytics/links/{link_id}/devices")
async def get_link_device_breakdown(
    link_id: str,
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None, description="Start date (ISO 8601)"),
    end_date: Optional[str] = Query(default=None, description="End date (ISO 8601)"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get device and browser breakdown for a specific link."""
    await _get_user_link(link_id, user.user_id, session)

    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    device_result = await session.execute(
        select(
            ClickEvent.device_type,
            func.count(ClickEvent.id).label("clicks"),
        )
        .where(
            ClickEvent.link_id == link_id,
            ClickEvent.clicked_at >= range_start,
            ClickEvent.clicked_at <= range_end,
        )
        .group_by(ClickEvent.device_type)
        .order_by(func.count(ClickEvent.id).desc())
    )

    browser_result = await session.execute(
        select(
            ClickEvent.browser,
            func.count(ClickEvent.id).label("clicks"),
        )
        .where(
            ClickEvent.link_id == link_id,
            ClickEvent.clicked_at >= range_start,
            ClickEvent.clicked_at <= range_end,
        )
        .group_by(ClickEvent.browser)
        .order_by(func.count(ClickEvent.id).desc())
    )

    return {
        "devices": [
            {"device_type": r.device_type, "clicks": r.clicks}
            for r in device_result.all()
        ],
        "browsers": [
            {"browser": r.browser, "clicks": r.clicks}
            for r in browser_result.all()
        ],
    }


# ============================================================================
# Campaign-Level Analytics (auth required)
# ============================================================================


@router.get("/analytics/campaigns")
async def list_campaigns(
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List all campaigns with summary stats."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= range_start,
        LinkClick.created_at <= range_end,
        LinkClick.utm_campaign.isnot(None),
        LinkClick.utm_campaign != "",
    ]
    if project_id:
        conditions.append(LinkClick.project_id == _to_uuid(project_id))

    result = await session.execute(
        select(
            LinkClick.utm_campaign,
            func.count(LinkClick.id).label("total_links"),
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
            func.min(LinkClick.created_at).label("first_link_created"),
            func.max(LinkClick.last_clicked_at).label("last_click_at"),
        )
        .where(*conditions)
        .group_by(LinkClick.utm_campaign)
        .order_by(func.sum(LinkClick.click_count).desc())
    )

    campaigns = []
    for r in result.all():
        total_links = r.total_links or 0
        total_clicks = int(r.total_clicks) if r.total_clicks else 0
        unique_clicks = int(r.unique_clicks) if r.unique_clicks else 0
        campaigns.append({
            "campaign": r.utm_campaign,
            "total_links": total_links,
            "total_clicks": total_clicks,
            "unique_clicks": unique_clicks,
            "click_rate": round((unique_clicks / total_links * 100) if total_links > 0 else 0.0, 2),
            "first_link_created": r.first_link_created.isoformat() if r.first_link_created else None,
            "last_click_at": r.last_click_at.isoformat() if r.last_click_at else None,
        })

    return campaigns


@router.get("/analytics/campaigns/compare")
async def compare_campaigns(
    campaigns: str = Query(description="Comma-separated campaign names (max 4)"),
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Compare 2-4 campaigns side by side."""
    campaign_list = [c.strip() for c in campaigns.split(",") if c.strip()]
    if len(campaign_list) < 2 or len(campaign_list) > 4:
        raise HTTPException(status_code=400, detail="Provide 2-4 campaign names separated by commas.")

    range_start, range_end = _resolve_date_range(days, start_date, end_date)
    results = []

    for name in campaign_list:
        # Summary
        agg = await session.execute(
            select(
                func.count(LinkClick.id).label("total_links"),
                func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
                func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
            )
            .where(
                LinkClick.user_id == user.user_id,
                LinkClick.utm_campaign == name,
                LinkClick.created_at >= range_start,
                LinkClick.created_at <= range_end,
            )
        )
        row = agg.one()

        # Top countries
        geo = await session.execute(
            select(ClickEvent.country, ClickEvent.country_code, func.count(ClickEvent.id).label("clicks"))
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(
                LinkClick.user_id == user.user_id,
                LinkClick.utm_campaign == name,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.country, ClickEvent.country_code)
            .order_by(func.count(ClickEvent.id).desc())
            .limit(5)
        )

        # Top devices
        devices = await session.execute(
            select(ClickEvent.device_type, func.count(ClickEvent.id).label("clicks"))
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(
                LinkClick.user_id == user.user_id,
                LinkClick.utm_campaign == name,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.device_type)
            .order_by(func.count(ClickEvent.id).desc())
        )

        # Timeline
        timeline = await session.execute(
            select(
                func.date_trunc("day", ClickEvent.clicked_at).label("date"),
                func.count(ClickEvent.id).label("clicks"),
            )
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(
                LinkClick.user_id == user.user_id,
                LinkClick.utm_campaign == name,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(func.date_trunc("day", ClickEvent.clicked_at))
            .order_by(func.date_trunc("day", ClickEvent.clicked_at))
        )

        total_links = row.total_links or 0
        total_clicks = int(row.total_clicks) if row.total_clicks else 0
        unique_clicks = int(row.unique_clicks) if row.unique_clicks else 0

        results.append({
            "campaign": name,
            "total_links": total_links,
            "total_clicks": total_clicks,
            "unique_clicks": unique_clicks,
            "click_rate": round((unique_clicks / total_links * 100) if total_links > 0 else 0.0, 2),
            "top_countries": [
                {"country": r.country, "country_code": r.country_code, "clicks": r.clicks}
                for r in geo.all()
            ],
            "top_devices": [
                {"device_type": r.device_type, "clicks": r.clicks}
                for r in devices.all()
            ],
            "timeline": [
                {"date": r.date.isoformat() if r.date else None, "clicks": r.clicks}
                for r in timeline.all()
            ],
        })

    return {"campaigns": results}


@router.get("/analytics/campaigns/{campaign_name}")
async def get_campaign_detail(
    campaign_name: str,
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get detailed analytics for a specific campaign."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    link_conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.utm_campaign == campaign_name,
        LinkClick.created_at >= range_start,
        LinkClick.created_at <= range_end,
    ]
    if project_id:
        link_conditions.append(LinkClick.project_id == _to_uuid(project_id))

    # Aggregate stats
    agg = await session.execute(
        select(
            func.count(LinkClick.id).label("total_links"),
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
        )
        .where(*link_conditions)
    )
    row = agg.one()
    total_links = row.total_links or 0
    total_clicks = int(row.total_clicks) if row.total_clicks else 0
    unique_clicks = int(row.unique_clicks) if row.unique_clicks else 0

    # Sources within campaign
    source_result = await session.execute(
        select(
            LinkClick.utm_source,
            func.coalesce(func.sum(LinkClick.click_count), 0).label("clicks"),
        )
        .where(*link_conditions, LinkClick.utm_source.isnot(None))
        .group_by(LinkClick.utm_source)
        .order_by(func.sum(LinkClick.click_count).desc())
        .limit(10)
    )

    # Mediums within campaign
    medium_result = await session.execute(
        select(
            LinkClick.utm_medium,
            func.coalesce(func.sum(LinkClick.click_count), 0).label("clicks"),
        )
        .where(*link_conditions, LinkClick.utm_medium.isnot(None))
        .group_by(LinkClick.utm_medium)
        .order_by(func.sum(LinkClick.click_count).desc())
        .limit(10)
    )

    return {
        "campaign": campaign_name,
        "total_links": total_links,
        "total_clicks": total_clicks,
        "unique_clicks": unique_clicks,
        "click_rate": round((unique_clicks / total_links * 100) if total_links > 0 else 0.0, 2),
        "sources": [
            {"source": r.utm_source, "clicks": int(r.clicks)}
            for r in source_result.all()
        ],
        "mediums": [
            {"medium": r.utm_medium, "clicks": int(r.clicks)}
            for r in medium_result.all()
        ],
    }


@router.get("/analytics/campaigns/{campaign_name}/geo")
async def get_campaign_geo(
    campaign_name: str,
    level: str = Query(default="country", description="Geo level: country, region, city"),
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get geographic breakdown for a campaign."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    if level == "region":
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                ClickEvent.region,
                func.count(ClickEvent.id).label("clicks"),
            )
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(
                LinkClick.user_id == user.user_id,
                LinkClick.utm_campaign == campaign_name,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [
            {"country": r.country, "country_code": r.country_code, "region": r.region, "clicks": r.clicks}
            for r in result.all()
        ]
    elif level == "city":
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                ClickEvent.region,
                ClickEvent.city,
                func.count(ClickEvent.id).label("clicks"),
            )
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(
                LinkClick.user_id == user.user_id,
                LinkClick.utm_campaign == campaign_name,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region, ClickEvent.city)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [
            {"country": r.country, "country_code": r.country_code, "region": r.region, "city": r.city, "clicks": r.clicks}
            for r in result.all()
        ]
    else:
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                func.count(ClickEvent.id).label("clicks"),
            )
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(
                LinkClick.user_id == user.user_id,
                LinkClick.utm_campaign == campaign_name,
                ClickEvent.clicked_at >= range_start,
                ClickEvent.clicked_at <= range_end,
            )
            .group_by(ClickEvent.country, ClickEvent.country_code)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [
            {"country": r.country, "country_code": r.country_code, "clicks": r.clicks}
            for r in result.all()
        ]


@router.get("/analytics/campaigns/{campaign_name}/devices")
async def get_campaign_devices(
    campaign_name: str,
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get device/browser/OS breakdown for a campaign."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    base_conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.utm_campaign == campaign_name,
        ClickEvent.clicked_at >= range_start,
        ClickEvent.clicked_at <= range_end,
    ]

    device_result = await session.execute(
        select(ClickEvent.device_type, func.count(ClickEvent.id).label("clicks"))
        .join(LinkClick, ClickEvent.link_id == LinkClick.id)
        .where(*base_conditions)
        .group_by(ClickEvent.device_type)
        .order_by(func.count(ClickEvent.id).desc())
    )

    browser_result = await session.execute(
        select(ClickEvent.browser, func.count(ClickEvent.id).label("clicks"))
        .join(LinkClick, ClickEvent.link_id == LinkClick.id)
        .where(*base_conditions)
        .group_by(ClickEvent.browser)
        .order_by(func.count(ClickEvent.id).desc())
        .limit(10)
    )

    os_result = await session.execute(
        select(ClickEvent.os, func.count(ClickEvent.id).label("clicks"))
        .join(LinkClick, ClickEvent.link_id == LinkClick.id)
        .where(*base_conditions)
        .group_by(ClickEvent.os)
        .order_by(func.count(ClickEvent.id).desc())
        .limit(10)
    )

    return {
        "devices": [{"device_type": r.device_type, "clicks": r.clicks} for r in device_result.all()],
        "browsers": [{"browser": r.browser, "clicks": r.clicks} for r in browser_result.all()],
        "os": [{"os": r.os, "clicks": r.clicks} for r in os_result.all()],
    }


@router.get("/analytics/campaigns/{campaign_name}/links")
async def get_campaign_links(
    campaign_name: str,
    request: Request,
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get top performing links within a campaign."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    result = await session.execute(
        select(LinkClick)
        .where(
            LinkClick.user_id == user.user_id,
            LinkClick.utm_campaign == campaign_name,
            LinkClick.created_at >= range_start,
            LinkClick.created_at <= range_end,
        )
        .order_by(LinkClick.click_count.desc())
        .limit(100)
    )

    return [
        {
            "link_id": str(link.id),
            "original_url": link.original_url,
            "tracked_url": link.tracked_url,
            "redirect_url": _build_redirect_url(link.short_code, request),
            "short_code": link.short_code,
            "utm_source": link.utm_source,
            "utm_medium": link.utm_medium,
            "click_count": link.click_count or 0,
            "unique_clicks": link.unique_clicks or 0,
            "created_at": link.created_at.isoformat() if link.created_at else None,
        }
        for link in result.scalars().all()
    ]


@router.get("/analytics/campaigns/{campaign_name}/timeline")
async def get_campaign_timeline(
    campaign_name: str,
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get daily click time series for a campaign."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    result = await session.execute(
        select(
            func.date_trunc("day", ClickEvent.clicked_at).label("date"),
            func.count(ClickEvent.id).label("clicks"),
            func.count(func.distinct(ClickEvent.ip_address)).label("unique_clicks"),
        )
        .join(LinkClick, ClickEvent.link_id == LinkClick.id)
        .where(
            LinkClick.user_id == user.user_id,
            LinkClick.utm_campaign == campaign_name,
            ClickEvent.clicked_at >= range_start,
            ClickEvent.clicked_at <= range_end,
        )
        .group_by(func.date_trunc("day", ClickEvent.clicked_at))
        .order_by(func.date_trunc("day", ClickEvent.clicked_at))
    )

    return {
        "campaign": campaign_name,
        "data": [
            {
                "date": r.date.isoformat() if r.date else None,
                "clicks": r.clicks or 0,
                "unique_clicks": r.unique_clicks or 0,
            }
            for r in result.all()
        ],
    }



# ============================================================================
# Global Geo Analytics (auth required)
# ============================================================================


@router.get("/analytics/geo/overview")
async def get_geo_overview(
    level: str = Query(default="country", description="Geo level: country, region, city"),
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    campaign: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get global geographic breakdown across all user's links."""
    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    base_conditions = [
        LinkClick.user_id == user.user_id,
        ClickEvent.clicked_at >= range_start,
        ClickEvent.clicked_at <= range_end,
    ]
    if project_id:
        base_conditions.append(LinkClick.project_id == _to_uuid(project_id))
    if campaign:
        base_conditions.append(LinkClick.utm_campaign == campaign)

    if level == "region":
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                ClickEvent.region,
                func.count(ClickEvent.id).label("clicks"),
            )
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(*base_conditions)
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region)
            .order_by(func.count(ClickEvent.id).desc())
            .limit(50)
        )
        return [
            {"country": r.country, "country_code": r.country_code, "region": r.region, "clicks": r.clicks}
            for r in result.all()
        ]
    elif level == "city":
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                ClickEvent.region,
                ClickEvent.city,
                func.count(ClickEvent.id).label("clicks"),
            )
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(*base_conditions)
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region, ClickEvent.city)
            .order_by(func.count(ClickEvent.id).desc())
            .limit(50)
        )
        return [
            {"country": r.country, "country_code": r.country_code, "region": r.region, "city": r.city, "clicks": r.clicks}
            for r in result.all()
        ]
    else:
        result = await session.execute(
            select(
                ClickEvent.country,
                ClickEvent.country_code,
                func.count(ClickEvent.id).label("clicks"),
            )
            .join(LinkClick, ClickEvent.link_id == LinkClick.id)
            .where(*base_conditions)
            .group_by(ClickEvent.country, ClickEvent.country_code)
            .order_by(func.count(ClickEvent.id).desc())
            .limit(50)
        )
        return [
            {"country": r.country, "country_code": r.country_code, "clicks": r.clicks}
            for r in result.all()
        ]


# ============================================================================
# Analytics Export (auth required)
# ============================================================================


@router.get("/analytics/export/events")
async def export_click_events(
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    campaign: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Export click events as CSV."""
    import csv
    import io

    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    conditions = [
        LinkClick.user_id == user.user_id,
        ClickEvent.clicked_at >= range_start,
        ClickEvent.clicked_at <= range_end,
    ]
    if project_id:
        conditions.append(LinkClick.project_id == _to_uuid(project_id))
    if campaign:
        conditions.append(LinkClick.utm_campaign == campaign)

    result = await session.execute(
        select(
            ClickEvent.clicked_at,
            LinkClick.original_url,
            LinkClick.short_code,
            LinkClick.utm_source,
            LinkClick.utm_medium,
            LinkClick.utm_campaign,
            LinkClick.utm_content,
            LinkClick.utm_term,
            ClickEvent.ip_address,
            ClickEvent.country,
            ClickEvent.region,
            ClickEvent.city,
            ClickEvent.device_type,
            ClickEvent.browser,
            ClickEvent.os,
            ClickEvent.referrer,
            ClickEvent.is_vpn,
            ClickEvent.asn_org,
        )
        .join(LinkClick, ClickEvent.link_id == LinkClick.id)
        .where(*conditions)
        .order_by(ClickEvent.clicked_at.desc())
        .limit(10000)
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "clicked_at", "original_url", "short_code",
        "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
        "ip_address", "country", "region", "city",
        "device_type", "browser", "os", "referrer", "is_vpn", "asn_org",
    ])
    for row in result.all():
        writer.writerow([
            row.clicked_at.isoformat() if row.clicked_at else "",
            row.original_url, row.short_code,
            row.utm_source, row.utm_medium, row.utm_campaign, row.utm_content, row.utm_term,
            row.ip_address, row.country, row.region, row.city,
            row.device_type, row.browser, row.os, row.referrer,
            "true" if row.is_vpn else "false",
            row.asn_org or "",
        ])

    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=click_events.csv"},
    )


@router.get("/analytics/export/campaign-summary")
async def export_campaign_summary(
    days: int = Query(default=90, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Export campaign summary as CSV."""
    import csv
    import io

    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    result = await session.execute(
        select(
            LinkClick.utm_campaign,
            func.count(LinkClick.id).label("total_links"),
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
            func.min(LinkClick.created_at).label("first_created"),
            func.max(LinkClick.last_clicked_at).label("last_clicked"),
        )
        .where(
            LinkClick.user_id == user.user_id,
            LinkClick.created_at >= range_start,
            LinkClick.created_at <= range_end,
            LinkClick.utm_campaign.isnot(None),
        )
        .group_by(LinkClick.utm_campaign)
        .order_by(func.sum(LinkClick.click_count).desc())
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["campaign", "total_links", "total_clicks", "unique_clicks", "click_rate", "first_created", "last_clicked"])
    for r in result.all():
        total_links = r.total_links or 0
        unique = int(r.unique_clicks) if r.unique_clicks else 0
        writer.writerow([
            r.utm_campaign,
            total_links,
            int(r.total_clicks) if r.total_clicks else 0,
            unique,
            round((unique / total_links * 100) if total_links > 0 else 0.0, 2),
            r.first_created.isoformat() if r.first_created else "",
            r.last_clicked.isoformat() if r.last_clicked else "",
        ])

    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=campaign_summary.csv"},
    )


@router.get("/analytics/export/link-performance")
async def export_link_performance(
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Export link performance as CSV."""
    import csv
    import io

    range_start, range_end = _resolve_date_range(days, start_date, end_date)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= range_start,
        LinkClick.created_at <= range_end,
    ]
    if project_id:
        conditions.append(LinkClick.project_id == _to_uuid(project_id))

    result = await session.execute(
        select(LinkClick)
        .where(*conditions)
        .order_by(LinkClick.click_count.desc())
        .limit(10000)
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "original_url", "tracked_url", "short_code",
        "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
        "project_name", "click_count", "unique_clicks", "created_at",
    ])
    for link in result.scalars().all():
        writer.writerow([
            link.original_url, link.tracked_url, link.short_code,
            link.utm_source, link.utm_medium, link.utm_campaign, link.utm_content, link.utm_term,
            link.project_name, link.click_count or 0, link.unique_clicks or 0,
            link.created_at.isoformat() if link.created_at else "",
        ])

    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=link_performance.csv"},
    )


# ============================================================================
# Link Tags (auth required)
# ============================================================================


@router.get("/tags")
async def list_tags(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List all tags for the authenticated user."""
    from app.models.utm import LinkTag

    result = await session.execute(
        select(LinkTag)
        .where(LinkTag.user_id == user.user_id)
        .order_by(LinkTag.name)
    )
    return [
        {"id": str(t.id), "name": t.name, "color": t.color, "created_at": t.created_at.isoformat() if t.created_at else None}
        for t in result.scalars().all()
    ]


@router.post("/tags", status_code=201)
async def create_tag(
    data: dict,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new tag."""
    from uuid import uuid4

    from app.models.utm import LinkTag

    name = data.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tag name is required")

    tag = LinkTag(
        id=uuid4(),
        user_id=user.user_id,
        name=name,
        color=data.get("color"),
    )
    session.add(tag)
    await session.flush()

    return {"id": str(tag.id), "name": tag.name, "color": tag.color, "created_at": tag.created_at.isoformat() if tag.created_at else None}


@router.delete("/tags/{tag_id}", status_code=204)
async def delete_tag(
    tag_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a tag."""
    from app.models.utm import LinkTag

    result = await session.execute(
        select(LinkTag).where(LinkTag.id == tag_id, LinkTag.user_id == user.user_id)
    )
    tag = result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    await session.delete(tag)
    await session.flush()


@router.post("/links/{link_id}/tags/{tag_id}", status_code=201)
async def add_tag_to_link(
    link_id: str,
    tag_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Add a tag to a link."""
    from app.models.utm import LinkTag, LinkTagAssociation

    await _get_user_link(link_id, user.user_id, session)

    # Verify tag ownership
    tag_result = await session.execute(
        select(LinkTag).where(LinkTag.id == tag_id, LinkTag.user_id == user.user_id)
    )
    if not tag_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Tag not found")

    # Check if already associated
    existing = await session.execute(
        select(LinkTagAssociation).where(
            LinkTagAssociation.link_id == link_id,
            LinkTagAssociation.tag_id == tag_id,
        )
    )
    if existing.scalar_one_or_none():
        return {"status": "already_tagged"}

    assoc = LinkTagAssociation(link_id=link_id, tag_id=tag_id)
    session.add(assoc)
    await session.flush()
    return {"status": "tagged"}


@router.delete("/links/{link_id}/tags/{tag_id}", status_code=204)
async def remove_tag_from_link(
    link_id: str,
    tag_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove a tag from a link."""
    from app.models.utm import LinkTagAssociation

    await _get_user_link(link_id, user.user_id, session)

    result = await session.execute(
        select(LinkTagAssociation).where(
            LinkTagAssociation.link_id == link_id,
            LinkTagAssociation.tag_id == tag_id,
        )
    )
    assoc = result.scalar_one_or_none()
    if not assoc:
        raise HTTPException(status_code=404, detail="Tag not associated with this link")
    await session.delete(assoc)
    await session.flush()


# ============================================================================
# Real-Time Click Notifications (auth required)
# ============================================================================


@router.get("/analytics/clicks/recent")
async def get_recent_clicks(
    since: Optional[str] = Query(default=None, description="ISO timestamp to get clicks since"),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get recent click events for polling-based notifications."""
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            # Strip timezone info — DB uses naive timestamps (UTC assumed)
            since_dt = since_dt.replace(tzinfo=None)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid timestamp format")
    else:
        since_dt = datetime.utcnow() - timedelta(minutes=5)

    result = await session.execute(
        select(
            ClickEvent.id,
            ClickEvent.clicked_at,
            ClickEvent.country,
            ClickEvent.region,
            ClickEvent.device_type,
            ClickEvent.browser,
            LinkClick.original_url,
            LinkClick.short_code,
            LinkClick.utm_campaign,
            LinkClick.utm_source,
        )
        .join(LinkClick, ClickEvent.link_id == LinkClick.id)
        .where(
            LinkClick.user_id == user.user_id,
            ClickEvent.clicked_at > since_dt,
        )
        .order_by(ClickEvent.clicked_at.desc())
        .limit(50)
    )

    return [
        {
            "id": str(r.id),
            "clicked_at": r.clicked_at.isoformat() if r.clicked_at else None,
            "country": r.country,
            "region": r.region,
            "device_type": r.device_type,
            "browser": r.browser,
            "original_url": r.original_url,
            "short_code": r.short_code,
            "utm_campaign": r.utm_campaign,
            "utm_source": r.utm_source,
        }
        for r in result.all()
    ]
