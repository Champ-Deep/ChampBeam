"""bootstrap_db.main() connect-retry: a cold-start DNS/connection race on Railway
private networking must be retried (so boot doesn't crash → healthcheck timeout),
but a wrong-password auth error must fail fast, not stall.

Maps to docs/TESTING.md § Deploy / config: CFG-6, CFG-7.
"""

from __future__ import annotations

import pytest

import scripts.bootstrap_db as boot


class _DummyEngine:
    async def dispose(self):
        return None


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(boot, "create_async_engine", lambda url: _DummyEngine())

    async def _nosleep(_):
        return None

    monkeypatch.setattr(boot.asyncio, "sleep", _nosleep)


@pytest.mark.asyncio
async def test_cfg6_retries_transient_connection_then_succeeds(monkeypatch):
    calls = {"n": 0}

    async def _run(engine):
        calls["n"] += 1
        if calls["n"] < 3:
            raise OSError("[Errno -2] Name or service not known")
        return 0

    monkeypatch.setattr(boot, "_run_bootstrap", _run)
    rc = await boot.main()
    assert rc == 0
    assert calls["n"] == 3  # retried twice, succeeded on the third attempt


@pytest.mark.asyncio
async def test_cfg7_auth_error_fails_fast_without_retry(monkeypatch):
    calls = {"n": 0}

    async def _run(engine):
        calls["n"] += 1
        raise boot.OperationalError(
            "SELECT 1", {}, Exception('password authentication failed for user "postgres"')
        )

    monkeypatch.setattr(boot, "_run_bootstrap", _run)
    with pytest.raises(boot.OperationalError):
        await boot.main()
    assert calls["n"] == 1  # not retried
