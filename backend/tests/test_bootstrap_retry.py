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


def test_cfg8_redacted_target_names_host_but_never_the_password(monkeypatch):
    """The startup diagnostic must show WHERE we connect (user/host/db) so an auth
    failure is diagnosable, but must never print the password into the logs."""
    secret = "sup3rS3cr3t_pw"
    monkeypatch.setattr(
        boot.settings,
        "database_url",
        f"postgresql://postgres:{secret}@shinkansen.proxy.rlwy.net:5432/railway",
    )
    target = boot._redacted_target()
    assert secret not in target  # password never leaks into logs
    assert "postgres" in target  # user is shown
    assert "shinkansen.proxy.rlwy.net" in target  # host is shown
    assert "railway" in target  # db name is shown
    assert "DATABASE_URL" in target  # reports where the URL came from
