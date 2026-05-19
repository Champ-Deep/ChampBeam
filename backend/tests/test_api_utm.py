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
