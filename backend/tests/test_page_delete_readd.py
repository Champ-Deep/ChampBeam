"""Deleting a file that is also a hosted page frees the page, its versions and its slug."""

from uuid import UUID

import pytest
from sqlalchemy import select

from tests.test_api_keys import _mint_key

HTML = b"<!doctype html><html><head><title>Plan</title></head><body>hi</body></html>"


@pytest.fixture()
def local_storage(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))


@pytest.mark.asyncio
async def test_delete_file_removes_page_and_slug_can_be_reused(app_client, local_storage):
    raw, _, _ = await _mint_key()
    h = {"X-API-Key": raw}
    up = lambda: app_client.post(  # noqa: E731
        "/api/v1/pages/upload", headers=h, data={"slug": "dyuthi-plan"},
        files={"file": ("Plan.html", HTML, "text/html")},
    )
    r = await up()
    assert r.status_code == 201, r.text
    page_id = r.json()["page_id"]

    d = await app_client.delete(f"/api/v1/files/{page_id}", headers=h)
    assert d.status_code in (200, 204), d.text
    assert (await app_client.get("/api/v1/pages", headers=h)).json() == []

    # Same slug again: must not 409 (and on Postgres must not trip the unique index).
    r2 = await up()
    assert r2.status_code == 201, r2.text

    from app.db.postgres import async_session_maker
    from app.models.file_version import FileVersion

    async with async_session_maker() as s:
        left = (await s.execute(select(FileVersion).where(FileVersion.file_id == UUID(page_id)))).scalars().all()
    assert left == []
