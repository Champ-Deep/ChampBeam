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

# Container-level liveness so Coolify / compose / Railway all grade the same
# thing. The app's /health also checks the database connection.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys,os; p=os.environ.get('PORT','8000'); sys.exit(0 if b'healthy' in urllib.request.urlopen(f'http://127.0.0.1:{p}/health', timeout=4).read() else 1)"

# On boot: fetch GeoIP DBs if a license key is set (best-effort, before the app
# imports the geo readers), idempotent schema safety net, apply migrations, then
# serve. This is THE start sequence for every environment (Railway test and
# Coolify prod both build this image), so test and prod boot identically.
#   PORT          injected by Railway; defaults to 8000 on Coolify / compose.
#   WEB_CONCURRENCY uvicorn worker count. 1 on the 2 vCPU shared box, 2 to 4
#                 once prod has its own cores (see docs/ENVIRONMENTS.md).
CMD ["sh", "-c", "python scripts/ensure_geoip.py && python scripts/bootstrap_db.py && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-1} --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 15"]
