# Champbeam backend image. Build context is the backend/ directory.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install Python deps first for better layer caching. build-essential is added
# only to compile any sdist-only wheels, then removed to keep the image lean.
COPY requirements.txt .
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && pip install -r requirements.txt \
    && apt-get purge -y build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# App source.
COPY . .

EXPOSE 8000

# On boot: fetch GeoIP DBs if a license key is set (best-effort, before the app
# imports the geo readers), idempotent schema safety net, apply migrations, then
# serve. Mirrors the Railway start command so behavior is identical off-Railway.
CMD ["sh", "-c", "python scripts/ensure_geoip.py && python scripts/bootstrap_db.py && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
