"""Project management service."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.utm import Project, LinkClick


class ProjectService:
    """CRUD operations for projects."""

    async def create_project(
        self, user_id: UUID, name: str, description: str | None, session: AsyncSession,
    ) -> Project:
        project = Project(id=uuid4(), user_id=user_id, name=name, description=description)
        session.add(project)
        await session.flush()
        return project

    async def list_projects(self, user_id: UUID, session: AsyncSession) -> list[Project]:
        result = await session.execute(
            select(Project)
            .where(Project.user_id == user_id)
            .order_by(Project.created_at.desc())
        )
        return list(result.scalars().all())

    async def get_project(
        self, project_id: UUID, user_id: UUID, session: AsyncSession,
    ) -> Project | None:
        result = await session.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def update_project(
        self, project: Project, name: str | None, description: str | None,
        session: AsyncSession,
    ) -> Project:
        if name is not None:
            project.name = name
        if description is not None:
            project.description = description
        project.updated_at = datetime.utcnow()
        await session.flush()
        return project

    async def delete_project(self, project: Project, session: AsyncSession) -> None:
        await session.delete(project)
        await session.flush()

    async def get_project_stats(self, project_id: UUID, session: AsyncSession) -> dict:
        """Get link count and total clicks for a project."""
        result = await session.execute(
            select(
                func.count(LinkClick.id).label("link_count"),
                func.coalesce(func.sum(LinkClick.click_count), 0).label("total_clicks"),
            ).where(LinkClick.project_id == project_id)
        )
        row = result.one()
        return {"link_count": row.link_count, "total_clicks": int(row.total_clicks)}


project_service = ProjectService()
