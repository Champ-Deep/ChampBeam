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
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TokenData, require_auth, get_current_user
from app.db.postgres import get_db_session
from app.db.redis import redis_client
from app.models.utm import LinkClick, UTMPreset
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
    preset_id: Optional[str] = None


class GenerateLinkResponse(BaseModel):
    original_url: str
    tracked_url: str
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
    original_url: str
    tracked_url: Optional[str] = None
    anchor_text: Optional[str] = None
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None
    utm_campaign: Optional[str] = None
    utm_content: Optional[str] = None
    utm_term: Optional[str] = None
    project_name: Optional[str] = None
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
    short_url = None
    if user:
        link = await utm_service.record_link(
            user_id=user.user_id,
            original_url=data.base_url,
            tracked_url=tracked_url,
            utm_params=utm_params,
            project_name=data.project_name,
            session=session,
        )
        link_id = str(link.id)
        if link.short_code:
            # The short URL is handled by the backend routing directly (/s/{short_code})
            # Use request.base_url to construct the absolute URL.
            short_url = str(request.base_url) + f"s/{link.short_code}"

    return GenerateLinkResponse(
        original_url=data.base_url,
        tracked_url=tracked_url,
        utm_params=utm_params,
        link_id=link_id,
        short_url=short_url,
    )


# ============================================================================
# Bulk CSV Processing (auth required)
# ============================================================================


@router.post("/bulk/generate")
async def generate_bulk_utm_links(
    file: UploadFile = File(...),
    preset_id: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Process a CSV of URLs and append UTM parameters.

    CSV must have a 'url' column. Can optionally include utm_source,
    utm_medium, etc. columns to override per row.
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
        result_csv = utm_service.process_bulk_csv(csv_content, default_params)
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
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """UTM analytics overview: total tracked links, clicks, top sources/campaigns."""
    cache_key = f"utm:overview:{user.user_id}"
    cached = await redis_client.get_json(cache_key)
    if cached:
        return UTMOverviewResponse(**cached)

    agg = await session.execute(
        select(
            func.count(LinkClick.id).label("total_links"),
            func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            func.coalesce(func.sum(LinkClick.unique_clicks), 0).label("unique_clicks"),
        )
        .where(LinkClick.user_id == user.user_id)
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
        .where(LinkClick.user_id == user.user_id, LinkClick.utm_source.isnot(None))
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
        .where(LinkClick.user_id == user.user_id, LinkClick.utm_campaign.isnot(None))
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

    await redis_client.set_json(cache_key, overview.model_dump(), ex=300)
    return overview


@router.get("/analytics/breakdown", response_model=List[UTMBreakdownItem])
async def get_utm_breakdown(
    group_by: str = Query(
        default="source",
        description="UTM field to group by: source, medium, campaign, content, term",
    ),
    project_name: Optional[str] = Query(default=None, description="Filter by project"),
    days: int = Query(default=30, ge=1, le=365, description="Days to look back"),
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

    start_date = datetime.utcnow() - timedelta(days=days)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= start_date,
        column.isnot(None),
    ]
    if project_name:
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
    project_name: Optional[str] = Query(default=None, description="Filter by project"),
    days: int = Query(default=30, ge=1, le=365),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List all tracked links with click stats, ordered by click_count desc."""
    start_date = datetime.utcnow() - timedelta(days=days)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= start_date,
    ]
    if project_name:
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
            original_url=link.original_url,
            tracked_url=link.tracked_url,
            anchor_text=link.anchor_text,
            utm_source=link.utm_source,
            utm_medium=link.utm_medium,
            utm_campaign=link.utm_campaign,
            utm_content=link.utm_content,
            utm_term=link.utm_term,
            project_name=link.project_name,
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
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get link generation and click counts over time (daily buckets)."""
    start_date = datetime.utcnow() - timedelta(days=days)

    conditions = [
        LinkClick.user_id == user.user_id,
        LinkClick.created_at >= start_date,
    ]
    if project_name:
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
