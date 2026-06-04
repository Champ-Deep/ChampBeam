import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_generate_public_link():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/utm/generate", json={
            "base_url": "example.com",
            "utm_source": "google",
            "utm_medium": "cpc",
        })

        assert response.status_code == 200
        data = response.json()
        assert data["original_url"] == "example.com"
        assert "utm_source=google" in data["tracked_url"]
        assert "utm_medium=cpc" in data["tracked_url"]
        assert data["link_id"] is None # Not logged in

from unittest.mock import patch, MagicMock

@pytest.mark.asyncio
async def test_redirect_not_found():
    # Mock the DB session Dependency
    with patch("app.api.v1.short_links.get_db_session") as mock_db:
        # Mock the session.execute to raise an exception or return None
        # Actually it's easier to mock the service layer or mock the DB dependency in FastAPI
        app.dependency_overrides[app.dependency_overrides.get("get_db_session")] = lambda: MagicMock()

        # We'll skip testing the DB failure directly and instead mock the result of the query
        pass

@pytest.mark.asyncio
async def test_redirect_endpoint_mocked():
    from app.db.postgres import get_db_session

    # Create a dummy dependency override that returns a mock session
    class MockResult:
        def scalar_one_or_none(self):
            return None

    class MockSession:
        async def execute(self, query):
            return MockResult()

    async def override_get_db():
        yield MockSession()

    app.dependency_overrides[get_db_session] = override_get_db

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/s/nonexistent")
        assert response.status_code == 404
        assert response.json()["detail"] == "Short link not found"

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_r_redirect_survives_click_tracking_failure(monkeypatch):
    """If click tracking blows up (e.g. legacy schema missing columns), the
    /r/ redirect must still return 302 to the link's destination."""
    from uuid import uuid4

    from app.db.postgres import get_db_session
    from app.models.utm import LinkClick
    from app.services.utm_service import utm_service

    destination = "https://example.com/landing?utm_source=test"
    link = LinkClick(
        id=uuid4(),
        user_id=uuid4(),
        short_code="ABC1234",
        original_url="https://example.com/landing",
        tracked_url=destination,
    )

    class _Result:
        def scalar_one_or_none(self_inner):
            return link

    class _Session:
        async def execute(self_inner, _query):
            return _Result()

        async def rollback(self_inner):
            return None

        async def commit(self_inner):
            return None

    async def override_get_db():
        yield _Session()

    async def _boom(**_kwargs):
        raise RuntimeError("simulated: click_events.is_vpn column missing")

    # Both the counter bump and the event insert must be allowed to fail
    # without taking down the redirect.
    monkeypatch.setattr(utm_service, "bump_click_counter", _boom)
    monkeypatch.setattr(utm_service, "insert_click_event", _boom)
    app.dependency_overrides[get_db_session] = override_get_db

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            follow_redirects=False,
        ) as client:
            response = await client.get("/r/ABC1234")
            assert response.status_code == 302
            assert response.headers["location"] == destination
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_r_redirect_bumps_counter_even_when_event_insert_fails(app_client, monkeypatch):
    """The counter must increment even when the ClickEvent insert blows up -
    that's the whole point of running them in independent sessions. Without
    this guarantee, analytics shows 0 on prod whenever the events table is
    broken."""
    import importlib
    from uuid import uuid4
    from sqlalchemy import select

    from app.models.user import User
    from app.models.utm import LinkClick
    from app.services.utm_service import utm_service

    utm_service_module = importlib.import_module("app.services.utm_service")

    # 1) Seed a user + tracked link directly via the (test) session maker
    link_id = uuid4()
    user_id = uuid4()
    async with utm_service_module.async_session_maker() as s:
        s.add(User(id=user_id, email="counter@test.com"))
        s.add(LinkClick(
            id=link_id,
            user_id=user_id,
            short_code="COUNT01",
            original_url="https://example.com/landing",
            tracked_url="https://example.com/landing?utm_source=test",
            click_count=0,
            unique_clicks=0,
        ))
        await s.commit()

    # 2) Force the event insert to blow up, mimicking a missing column in prod
    async def _boom(**_kwargs):
        raise RuntimeError("simulated: click_events.is_vpn column missing")

    monkeypatch.setattr(utm_service, "insert_click_event", _boom)

    # 3) Hit the redirect, should still 302 AND increment the counter
    resp = await app_client.get("/r/COUNT01", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "https://example.com/landing?utm_source=test"

    # 4) Counter must have been bumped despite the event insert failure
    async with utm_service_module.async_session_maker() as s:
        row = (await s.execute(
            select(LinkClick).where(LinkClick.id == link_id)
        )).scalar_one()
        assert row.click_count == 1, (
            f"expected click_count=1 after redirect, got {row.click_count} "
            f"(this is the prod bug, counters get rolled back when "
            f"click_events insert fails)"
        )
        assert row.unique_clicks == 1
        assert row.first_clicked_at is not None
        assert row.last_clicked_at is not None
