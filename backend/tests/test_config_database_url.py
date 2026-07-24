"""DATABASE_URL scheme normalization — the app must accept whatever shape a host
(Railway/Heroku/PaaS) hands us and always drive it through asyncpg.

Maps to docs/TESTING.md § Deploy / config: CFG-1..CFG-5. This guards the driver
scheme only; a wrong password in DATABASE_URL is an env-var issue, not code.
"""

from __future__ import annotations

import pytest

from app.core.config import Settings


@pytest.mark.parametrize(
    "given,expected",
    [
        # CFG-1: Railway/standard full scheme -> asyncpg
        (
            "postgresql://u:p@host:5432/db",
            "postgresql+asyncpg://u:p@host:5432/db",
        ),
        # CFG-2: Heroku/Railway shorthand -> asyncpg
        (
            "postgres://u:p@host:5432/db",
            "postgresql+asyncpg://u:p@host:5432/db",
        ),
        # CFG-3: already-explicit driver is passed through untouched
        (
            "postgresql+asyncpg://u:p@host:5432/db",
            "postgresql+asyncpg://u:p@host:5432/db",
        ),
        # CFG-4: surrounding whitespace (copy-paste) is trimmed
        (
            "  postgresql://u:p@host:5432/db  ",
            "postgresql+asyncpg://u:p@host:5432/db",
        ),
    ],
)
def test_database_url_scheme_is_normalized(given, expected):
    s = Settings(database_url=given)
    assert s.postgres_url == expected


def test_cfg5_falls_back_to_discrete_pg_vars_when_no_url():
    # CFG-5: with no DATABASE_URL, build from POSTGRES_* pieces (async driver).
    s = Settings(
        database_url="",
        postgres_user="champ",
        postgres_password="secret",
        postgres_host="db.internal",
        postgres_port=5432,
        postgres_db="champbeam",
    )
    assert s.postgres_url == "postgresql+asyncpg://champ:secret@db.internal:5432/champbeam"
