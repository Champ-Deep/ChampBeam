"""Project management API endpoints."""

from __future__ import annotations

from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TokenData, require_auth
from app.db.postgres import get_db_session
from app.services.project_service import project_service

router = APIRouter(prefix="/projects", tags=["Projects"])


# --- Request / Response Models ---


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    link_count: int = 0
    total_clicks: int = 0
    created_at: str


# --- Endpoints ---


@router.get("", response_model=List[ProjectResponse])
async def list_projects(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List all projects for the authenticated user."""
    projects = await project_service.list_projects(UUID(user.user_id), session)
    results = []
    for p in projects:
        stats = await project_service.get_project_stats(p.id, session)
        results.append(ProjectResponse(
            id=str(p.id),
            name=p.name,
            description=p.description,
            link_count=stats["link_count"],
            total_clicks=stats["total_clicks"],
            created_at=p.created_at.isoformat() if p.created_at else "",
        ))
    return results


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(
    data: ProjectCreate,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new project."""
    project = await project_service.create_project(
        user_id=UUID(user.user_id),
        name=data.name,
        description=data.description,
        session=session,
    )
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        description=project.description,
        created_at=project.created_at.isoformat() if project.created_at else "",
    )


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    data: ProjectUpdate,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an existing project."""
    project = await project_service.get_project(UUID(project_id), UUID(user.user_id), session)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project = await project_service.update_project(
        project, data.name, data.description, session,
    )
    stats = await project_service.get_project_stats(project.id, session)
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        description=project.description,
        link_count=stats["link_count"],
        total_clicks=stats["total_clicks"],
        created_at=project.created_at.isoformat() if project.created_at else "",
    )


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a project. Links in this project are preserved (project_id set to NULL)."""
    project = await project_service.get_project(UUID(project_id), UUID(user.user_id), session)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    await project_service.delete_project(project, session)
