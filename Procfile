web: cd backend && PYTHONPATH=. python scripts/bootstrap_db.py && alembic upgrade head && PYTHONPATH=. python scripts/ensure_geoip.py && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
# NO `release:` phase. On Railway/nixpacks a Procfile release command gets baked
# into the IMAGE BUILD, which has no database network — the private Postgres host
# (*.railway.internal) doesn't resolve at build time, so migrations there fail
# with a DNS error ("Name or service not known"), or an auth error on a public
# host. Migrations must run at RUNTIME: the `web:` line above (and railway.toml's
# startCommand) run bootstrap_db + `alembic upgrade head` on start, where the DB
# is reachable. For a dedicated pre-deploy step use Railway's "Pre-deploy
# Command" service setting (runtime) — never a Procfile release phase.
