"""Beam State API: token auth, comments, KV state, caps, kill switch, owner views."""

from __future__ import annotations

import re

import pytest

from app.core.config import settings
from app.db.redis import redis_client

HTML = "<html><head><title>b</title></head><body>board</body></html>"


@pytest.fixture()
def local_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    return tmp_path


async def _page(app_client, title="APAC Handover"):
    from tests.test_api_keys import _mint_key

    raw, _, _ = await _mint_key()
    h = {"X-API-Key": raw}
    r = await app_client.post("/api/v1/pages", json={"html": HTML, "title": title}, headers=h)
    assert r.status_code == 201, r.text
    page = r.json()
    # Serve once: mints the state token and injects the helper.
    served = await app_client.get(f"/p/{page['slug']}")
    assert served.status_code == 200
    m = re.search(r'window\.__BEAM__=\{page:"([^"]+)",token:"([^"]+)"', served.text)
    assert m, served.text[:400]
    assert m.group(1) == page["slug"]
    return h, page, m.group(2)


def _tok(token):
    return {"X-Beam-Token": token, "Content-Type": "application/json"}


@pytest.mark.asyncio
async def test_comments_and_state_round_trip(app_client, local_storage):
    h, page, token = await _page(app_client)
    slug = page["slug"]

    c1 = await app_client.post(f"/api/pages/{slug}/comments", json={"author": "Deep", "body": "first"}, headers=_tok(token))
    assert c1.status_code == 201 and c1.json()["author"] == "Deep"
    c2 = await app_client.post(f"/api/pages/{slug}/comments", json={"author": "Rohan", "body": "second"}, headers=_tok(token))
    listed = (await app_client.get(f"/api/pages/{slug}/comments", headers=_tok(token))).json()
    assert [c["body"] for c in listed["comments"]] == ["first", "second"]
    newer = (await app_client.get(f"/api/pages/{slug}/comments?after={c1.json()['id']}", headers=_tok(token))).json()
    assert [c["body"] for c in newer["comments"]] == ["second"]
    assert newer["next_after"] == c2.json()["id"]

    put = await app_client.put(f"/api/pages/{slug}/state/check:1", json={"done": True, "by": "Sonali"}, headers=_tok(token))
    assert put.status_code == 200 and put.json()["value"]["done"] is True
    put2 = await app_client.put(f"/api/pages/{slug}/state/check:1", json=False, headers=_tok(token))  # LWW overwrite
    assert put2.json()["value"] is False
    one = (await app_client.get(f"/api/pages/{slug}/state/check:1", headers=_tok(token))).json()
    assert one["value"] is False
    allst = (await app_client.get(f"/api/pages/{slug}/state", headers=_tok(token))).json()
    assert allst["state"] == {"check:1": False}
    assert (await app_client.get(f"/api/pages/{slug}/state/nope", headers=_tok(token))).status_code == 404
    assert (await app_client.delete(f"/api/pages/{slug}/state/check:1", headers=_tok(token))).status_code == 204
    assert (await app_client.get(f"/api/pages/{slug}/state", headers=_tok(token))).json()["state"] == {}

    # short_code works as the ident too
    assert (await app_client.get(f"/api/pages/{page['short_code']}/state", headers=_tok(token))).status_code == 200


@pytest.mark.asyncio
async def test_token_scope_and_validation(app_client, local_storage):
    h, a, tok_a = await _page(app_client, "Page A")
    _, b, tok_b = await _page(app_client, "Page B")

    assert (await app_client.get(f"/api/pages/{a['slug']}/state")).status_code == 401
    assert (await app_client.get(f"/api/pages/{a['slug']}/state", headers=_tok("nope"))).status_code == 401
    assert (await app_client.get(f"/api/pages/{a['slug']}/state", headers=_tok(tok_b))).status_code == 401
    assert (await app_client.get(f"/api/pages/{a['slug']}/state", headers={"Authorization": f"Bearer {tok_a}"})).status_code == 200
    assert (await app_client.get("/api/pages/no-such-page/state", headers=_tok(tok_a))).status_code == 404
    assert (await app_client.get(f"/api/pages/{a['slug']}/state", headers={**_tok(tok_a), "host": "nobody.example.com"})).status_code == 404

    big = await app_client.post(f"/api/pages/{a['slug']}/comments", json={"author": "x", "body": "y" * 4001}, headers=_tok(tok_a))
    assert big.status_code == 413
    bigv = await app_client.put(f"/api/pages/{a['slug']}/state/k", json={"blob": "z" * (16 * 1024 + 1)}, headers=_tok(tok_a))
    assert bigv.status_code == 413
    badkey = await app_client.put(f"/api/pages/{a['slug']}/state/bad key!", json=1, headers=_tok(tok_a))
    assert badkey.status_code == 400
    noauthor = await app_client.post(f"/api/pages/{a['slug']}/comments", json={"author": " ", "body": "hi"}, headers=_tok(tok_a))
    assert noauthor.status_code == 400


@pytest.mark.asyncio
async def test_caps_and_rate_limit(app_client, local_storage, monkeypatch):
    from app.services import page_state as ps

    h, page, token = await _page(app_client)
    slug = page["slug"]
    monkeypatch.setattr(ps, "MAX_KEYS_PER_PAGE", 2)
    monkeypatch.setattr(ps, "MAX_COMMENTS_PER_PAGE", 1)
    assert (await app_client.put(f"/api/pages/{slug}/state/a", json=1, headers=_tok(token))).status_code == 200
    assert (await app_client.put(f"/api/pages/{slug}/state/b", json=1, headers=_tok(token))).status_code == 200
    assert (await app_client.put(f"/api/pages/{slug}/state/c", json=1, headers=_tok(token))).status_code == 409
    assert (await app_client.put(f"/api/pages/{slug}/state/a", json=2, headers=_tok(token))).status_code == 200  # overwrite ok
    assert (await app_client.post(f"/api/pages/{slug}/comments", json={"author": "a", "body": "1"}, headers=_tok(token))).status_code == 201
    assert (await app_client.post(f"/api/pages/{slug}/comments", json={"author": "a", "body": "2"}, headers=_tok(token))).status_code == 409

    async def over(key, ttl):
        return 31

    monkeypatch.setattr(redis_client, "incr_with_ttl", over)
    assert (await app_client.put(f"/api/pages/{slug}/state/a", json=3, headers=_tok(token))).status_code == 429


@pytest.mark.asyncio
async def test_kill_switch_freezes_state(app_client, local_storage):
    h, page, token = await _page(app_client)
    slug, pid = page["slug"], page["page_id"]
    assert (await app_client.put(f"/api/pages/{slug}/state/x", json=1, headers=_tok(token))).status_code == 200
    off = await app_client.patch(f"/api/v1/pages/{pid}", json={"enabled": False}, headers=h)
    assert off.status_code == 200
    for method, path, body in [
        ("GET", f"/api/pages/{slug}/state", None),
        ("PUT", f"/api/pages/{slug}/state/x", 2),
        ("GET", f"/api/pages/{slug}/comments", None),
        ("POST", f"/api/pages/{slug}/comments", {"author": "a", "body": "b"}),
    ]:
        r = await app_client.request(method, path, json=body, headers=_tok(token))
        assert r.status_code == 410, (method, path, r.status_code)


@pytest.mark.asyncio
async def test_owner_views_rotate_and_timeline(app_client, local_storage):
    h, page, token = await _page(app_client)
    slug, pid = page["slug"], page["page_id"]
    c = (await app_client.post(f"/api/pages/{slug}/comments", json={"author": "Deep", "body": "hello"}, headers=_tok(token))).json()
    await app_client.put(f"/api/pages/{slug}/state/tick", json=True, headers=_tok(token))

    comments = (await app_client.get(f"/api/v1/pages/{pid}/comments", headers=h)).json()
    assert [x["body"] for x in comments] == ["hello"]
    state = (await app_client.get(f"/api/v1/pages/{pid}/state", headers=h)).json()
    assert state == {"state": {"tick": True}, "count": 1}

    tl = (await app_client.get(f"/api/v1/pages/{pid}/events", headers=h)).json()
    types = [x["type"] for x in tl]
    assert types.count("view") == 1 and "comment_added" in types and "state_changed" in types
    assert next(x for x in tl if x["type"] == "comment_added")["ref"] == c["id"]
    assert next(x for x in tl if x["type"] == "state_changed")["ref"] == "tick"

    assert (await app_client.delete(f"/api/v1/pages/{pid}/comments/{c['id']}", headers=h)).status_code == 204
    assert (await app_client.get(f"/api/v1/pages/{pid}/comments", headers=h)).json() == []
    assert (await app_client.delete(f"/api/v1/pages/{pid}/state", headers=h)).status_code == 204
    assert (await app_client.get(f"/api/v1/pages/{pid}/state", headers=h)).json()["count"] == 0

    rot = await app_client.post(f"/api/v1/pages/{pid}/state-token/rotate", headers=h)
    new_token = rot.json()["state_token"]
    assert new_token != token
    assert (await app_client.get(f"/api/pages/{slug}/state", headers=_tok(token))).status_code == 401
    assert (await app_client.get(f"/api/pages/{slug}/state", headers=_tok(new_token))).status_code == 200

    # non-owner 404 on owner routes
    from tests.test_api_keys import _mint_key

    other, _, _ = await _mint_key()
    assert (await app_client.get(f"/api/v1/pages/{pid}/state", headers={"X-API-Key": other})).status_code == 404
