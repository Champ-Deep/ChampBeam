"""Access-code gate for Beam Pages."""

from __future__ import annotations

import pytest

from app.core.config import settings
from app.db.redis import redis_client

HTML = "<html><head></head><body>secret plan</body></html>"


@pytest.fixture()
def local_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    return tmp_path


async def _gated_page(app_client, code="483920"):
    from tests.test_api_keys import _mint_key

    raw, _, _ = await _mint_key()
    h = {"X-API-Key": raw}
    page = (await app_client.post("/api/v1/pages", json={"html": HTML, "title": "Board"}, headers=h)).json()
    r = await app_client.patch(f"/api/v1/pages/{page['page_id']}", json={"access_code": code}, headers=h)
    assert r.status_code == 200 and r.json()["has_access_code"] is True, r.text
    return h, page


@pytest.mark.asyncio
async def test_gate_flow(app_client, local_storage):
    h, page = await _gated_page(app_client)
    slug, pid, code = page["slug"], page["page_id"], page["short_code"]

    gate = await app_client.get(f"/p/{slug}")
    assert gate.status_code == 200 and "Enter the access code" in gate.text and "secret plan" not in gate.text

    wrong = await app_client.post(f"/f/{code}/unlock-code", data={"code": "000000"})
    assert wrong.status_code == 200 and "isn’t right" in wrong.text
    tl = (await app_client.get(f"/api/v1/pages/{pid}/events", headers=h)).json()
    assert any(x["type"] == "gate_failed" and x["ref"] == "code" for x in tl)

    ok = await app_client.post(f"/p/{slug}/unlock-code", data={"code": "483920"})
    assert ok.status_code == 303 and ok.headers["location"] == f"/p/{slug}"
    assert any(k.startswith("cbcode_") for k in ok.cookies.keys())

    served = await app_client.get(f"/p/{slug}")  # jar carries the cookie
    assert served.status_code == 200 and "secret plan" in served.text

    # Changing the code invalidates the cookie.
    await app_client.patch(f"/api/v1/pages/{pid}", json={"access_code": "1234"}, headers=h)
    assert "Enter the access code" in (await app_client.get(f"/p/{slug}")).text
    # Clearing removes the gate entirely.
    r = await app_client.patch(f"/api/v1/pages/{pid}", json={"access_code": None}, headers=h)
    assert r.json()["has_access_code"] is False
    assert "secret plan" in (await app_client.get(f"/p/{slug}")).text


@pytest.mark.asyncio
async def test_code_gate_precedes_email_gate_and_composes(app_client, local_storage):
    h, page = await _gated_page(app_client)
    slug, pid, code = page["slug"], page["page_id"], page["short_code"]
    r = await app_client.put(f"/api/v1/files/{pid}/access", json={"require_email": True}, headers=h)
    assert r.status_code == 200
    first = await app_client.get(f"/p/{slug}")
    assert "Enter the access code" in first.text and "email" not in first.text.lower().split("<form")[0]
    await app_client.post(f"/f/{code}/unlock-code", data={"code": "483920"})
    second = await app_client.get(f"/p/{slug}")
    assert "Enter your email" in second.text
    await app_client.post(f"/f/{code}/unlock", data={"email": "deep@example.com"})
    assert "secret plan" in (await app_client.get(f"/p/{slug}")).text


@pytest.mark.asyncio
async def test_attempt_limit_and_validation(app_client, local_storage, monkeypatch):
    h, page = await _gated_page(app_client)
    code = page["short_code"]

    async def over(key, ttl):
        return 6

    monkeypatch.setattr(redis_client, "incr_with_ttl", over)
    limited = await app_client.post(f"/f/{code}/unlock-code", data={"code": "483920"})
    assert limited.status_code == 429 and "Too many attempts" in limited.text

    bad = await app_client.patch(f"/api/v1/pages/{page['page_id']}", json={"access_code": "12"}, headers=h)
    assert bad.status_code == 422
    bad2 = await app_client.patch(f"/api/v1/pages/{page['page_id']}", json={"access_code": "abcd"}, headers=h)
    assert bad2.status_code == 422


def test_hash_is_per_page():
    from uuid import uuid4

    from app.api.access_control import hash_access_code

    assert hash_access_code(uuid4(), "1234") != hash_access_code(uuid4(), "1234")
