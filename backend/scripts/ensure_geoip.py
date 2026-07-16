"""Best-effort downloader for the MaxMind GeoLite2 City + ASN databases.

Runs before the app boots (the geoip readers load at import time, so the files
must exist beforehand). No-ops unless a database is missing AND a license key is
set; never fails the boot. Without these DBs, ISP/VPN detection falls back to
ip-api.com, whose free tier blocks datacenter/VPS IPs — so on a VPS the local
databases are what keep VPN/ISP detection working.

Enable by setting MAXMIND_LICENSE_KEY (free: https://www.maxmind.com/en/geolite2/signup)
and mounting a persistent volume at the data directory so the download is a
one-time cost.
"""

from __future__ import annotations

import io
import logging
import os
import sys
import tarfile

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ensure_geoip")

EDITIONS = {
    "GeoLite2-City": os.getenv("MAXMIND_DB_PATH", "data/GeoLite2-City.mmdb"),
    "GeoLite2-ASN": os.getenv("MAXMIND_ASN_DB_PATH", "data/GeoLite2-ASN.mmdb"),
}


def _download(edition: str, key: str, dest: str) -> None:
    import httpx

    url = (
        "https://download.maxmind.com/app/geoip_download"
        f"?edition_id={edition}&license_key={key}&suffix=tar.gz"
    )
    # Bounded so a slow/hung MaxMind endpoint can't stall boot past the
    # healthcheck window. Override via GEOIP_DOWNLOAD_TIMEOUT (seconds).
    timeout = float(os.getenv("GEOIP_DOWNLOAD_TIMEOUT", "20"))
    resp = httpx.get(url, timeout=timeout, follow_redirects=True)
    resp.raise_for_status()
    with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as tar:
        member = next(
            (m for m in tar.getmembers() if m.name.endswith(f"{edition}.mmdb")), None
        )
        if member is None:
            raise RuntimeError(f"{edition}.mmdb not found in archive")
        extracted = tar.extractfile(member)
        if extracted is None:
            raise RuntimeError(f"could not read {edition}.mmdb from archive")
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        with open(dest, "wb") as out:
            out.write(extracted.read())


def _web_provider_configured() -> bool:
    """True when a datacenter-safe web geo provider is set (MaxMind GeoIP2 /
    Insights web service, or IPinfo). Then local .mmdb files aren't needed for
    geo/VPN, so we must NOT spend boot time downloading them."""
    return bool(os.getenv("MAXMIND_ACCOUNT_ID") or os.getenv("IPINFO_API_TOKEN"))


def main() -> None:
    # CRITICAL: this runs on the start command BEFORE uvicorn binds. It must never
    # block long, or the platform healthcheck times out before the server is up.
    # If a web provider is configured we skip the download entirely (the common
    # case now — MaxMind Insights / IPinfo resolve over HTTPS with no local DB).
    # Force the download anyway with GEOIP_FORCE_DOWNLOAD=1.
    force = os.getenv("GEOIP_FORCE_DOWNLOAD", "").lower() in ("1", "true", "yes")
    if _web_provider_configured() and not force:
        log.info(
            "A web geo provider is configured (MaxMind web service / IPinfo); "
            "skipping local GeoIP DB download so boot isn't delayed."
        )
        return

    missing = {e: d for e, d in EDITIONS.items() if not os.path.exists(d)}
    if not missing:
        log.info("GeoIP databases present; skipping download.")
        return
    key = os.getenv("MAXMIND_LICENSE_KEY") or os.getenv("MAXMIND_KEY")
    if not key:
        log.warning(
            "GeoIP databases missing (%s) and MAXMIND_LICENSE_KEY is unset; "
            "ISP/VPN detection will rely on the rate-limited ip-api.com fallback.",
            ", ".join(missing),
        )
        return
    for edition, dest in missing.items():
        try:
            _download(edition, key, dest)
            log.info("Downloaded %s -> %s", edition, dest)
        except Exception as exc:  # noqa: BLE001 - best-effort, must not block boot
            log.warning("Could not download %s: %s", edition, exc)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        log.warning("ensure_geoip failed: %s", exc)
    sys.exit(0)
