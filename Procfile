web: cd backend && PYTHONPATH=. python scripts/bootstrap_db.py && alembic upgrade head && PYTHONPATH=. python scripts/ensure_geoip.py && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
release: cd backend && PYTHONPATH=. python scripts/bootstrap_db.py && alembic upgrade head
