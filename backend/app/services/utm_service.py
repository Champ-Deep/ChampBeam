"""
UTM Service for Champbeam.

Handles URL generation, bulk CSV processing, click tracking, and redirect recording.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import secrets
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from uuid import UUID, uuid4

from sqlalchemy import func, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.postgres import async_session_maker
from app.models.utm import ClickEvent, LinkClick, UTMPreset
from app.services.ua_service import parse_user_agent

logger = logging.getLogger(__name__)


UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term")


class UTMService:
    """Service for UTM URL generation, link tracking, and bulk processing."""

    # ------------------------------------------------------------------
    # Generate a single UTM URL
    # ------------------------------------------------------------------

    def generate_utm_url(
        self,
        base_url: str,
        utm_params: Dict[str, str],
        preserve_existing: bool = True,
    ) -> str:
        """Build a URL with UTM parameters appended.

        Parameters
        ----------
        base_url : str
            The target URL to append UTM parameters to.
        utm_params : dict
            UTM parameters (utm_source, utm_medium, etc.).
        preserve_existing : bool
            If True, don't overwrite UTM params already in the URL.

        Returns
        -------
        str
            The URL with UTM parameters.
        """
        # Strip trailing hashes and question marks if user inputs them accidentally
        base_url = base_url.strip()
        while base_url.endswith(("?", "#")):
            base_url = base_url[:-1]

        parsed = urlparse(base_url)

        # Ensure scheme
        if not parsed.scheme:
            base_url = "https://" + base_url
            parsed = urlparse(base_url)

        # Clean up path by replacing multiple slashes with a single one
        # but don't mess up the domain/scheme part (e.g. https://)
        cleaned_path = re.sub(r'//+', '/', parsed.path)

        existing_qs = parse_qs(parsed.query, keep_blank_values=True)

        for key, value in utm_params.items():
            if not value:
                continue

            # Clean up the value as well
            value = str(value).strip()
            if not value:
                continue

            if preserve_existing and key in existing_qs:
                continue
            existing_qs[key] = [value]

        # Use doseq=True to handle multiple values correctly, but we only appended 1 value per list
        new_query = urlencode(existing_qs, doseq=True)
        return urlunparse((
            parsed.scheme,
            parsed.netloc,
            cleaned_path,
            parsed.params,
            new_query,
            parsed.fragment,
        ))

    # ------------------------------------------------------------------
    # Record a generated link for tracking
    # ------------------------------------------------------------------

    def _generate_short_code(self) -> str:
        import secrets
        import string
        alphabet = string.ascii_letters + string.digits
        return ''.join(secrets.choice(alphabet) for _ in range(7))

    async def record_link(
        self,
        user_id: str,
        original_url: str,
        tracked_url: str,
        utm_params: Dict[str, str],
        project_name: Optional[str] = None,
        project_id: Optional[UUID] = None,
        domain_id: Optional[UUID] = None,
        session: Optional[AsyncSession] = None,
    ) -> LinkClick:
        """Record a generated link for click tracking.

        Parameters
        ----------
        user_id : str
            User UUID.
        original_url : str
            The original URL before UTM params.
        tracked_url : str
            The URL with UTM params appended.
        utm_params : dict
            The UTM parameters used.
        project_name : str or None
            Optional project grouping (legacy).
        project_id : UUID or None
            Optional project FK.
        session : AsyncSession or None
            Database session. Opens a new one if not provided.

        Returns
        -------
        LinkClick
            The created record.
        """
        # Dedup: check if identical link already exists for this user
        src = utm_params.get("utm_source")
        med = utm_params.get("utm_medium")
        cam = utm_params.get("utm_campaign")
        con = utm_params.get("utm_content")
        trm = utm_params.get("utm_term")

        async def _find_existing(s: AsyncSession) -> Optional[LinkClick]:
            stmt = select(LinkClick).where(
                LinkClick.user_id == user_id,
                LinkClick.original_url == original_url,
                LinkClick.utm_source == src if src else LinkClick.utm_source.is_(None),
                LinkClick.utm_medium == med if med else LinkClick.utm_medium.is_(None),
                LinkClick.utm_campaign == cam if cam else LinkClick.utm_campaign.is_(None),
                LinkClick.utm_content == con if con else LinkClick.utm_content.is_(None),
                LinkClick.utm_term == trm if trm else LinkClick.utm_term.is_(None),
                LinkClick.domain_id == domain_id if domain_id else LinkClick.domain_id.is_(None),
            )
            result = await s.execute(stmt)
            return result.scalar_one_or_none()

        # Check for existing link and update project if needed
        if session:
            existing = await _find_existing(session)
            if existing:
                if project_id and existing.project_id != project_id:
                    existing.project_id = project_id
                    await session.flush()
                return existing
        else:
            async with async_session_maker() as s:
                existing = await _find_existing(s)
                if existing:
                    if project_id and existing.project_id != project_id:
                        existing.project_id = project_id
                        await s.commit()
                    return existing
        s_code = self._generate_short_code()

        link = LinkClick(
            id=uuid4(),
            user_id=user_id,
            short_code=s_code,
            project_id=project_id,
            project_name=project_name,
            domain_id=domain_id,
            original_url=original_url,
            tracked_url=tracked_url,
            utm_source=src,
            utm_medium=med,
            utm_campaign=cam,
            utm_content=con,
            utm_term=trm,
            click_count=0,
            unique_clicks=0,
        )

        if session:
            # Check for uniqueness in loop if highly contested, but 7 chars is plenty.
            session.add(link)
            await session.flush()
        else:
            async with async_session_maker() as s:
                s.add(link)
                await s.commit()

        return link

    async def record_click_event(
        self,
        link: LinkClick,
        ip_address: Optional[str],
        user_agent_str: Optional[str],
        referrer: Optional[str],
        session: AsyncSession,
        domain_id: Optional[UUID] = None,
    ) -> ClickEvent:
        """Record an individual click event with parsed UA info.

        GeoIP is resolved separately via a background task.
        """
        ua_info = parse_user_agent(user_agent_str or "")

        # Check if this IP has clicked this link before (for unique tracking)
        is_unique = True
        if ip_address:
            existing = await session.execute(
                select(ClickEvent.id).where(
                    ClickEvent.link_id == link.id,
                    ClickEvent.ip_address == ip_address,
                ).limit(1)
            )
            if existing.scalar_one_or_none() is not None:
                is_unique = False

        event = ClickEvent(
            id=uuid4(),
            link_id=link.id,
            domain_id=domain_id if domain_id is not None else link.domain_id,
            ip_address=ip_address,
            user_agent=user_agent_str,
            referrer=referrer,
            device_type=ua_info["device_type"],
            browser=ua_info["browser"],
            os=ua_info["os"],
        )
        session.add(event)

        # Update counters on LinkClick
        now = datetime.utcnow()
        link.click_count = (link.click_count or 0) + 1
        link.last_clicked_at = now
        if link.first_clicked_at is None:
            link.first_clicked_at = now
        if is_unique:
            link.unique_clicks = (link.unique_clicks or 0) + 1

        await session.flush()
        return event

    async def bump_click_counter(
        self,
        link_id: UUID,
        ip_address: Optional[str],
    ) -> None:
        """Atomically increment click counters on a LinkClick.

        Uses its own fresh session and a single UPDATE statement that only
        touches the ``link_clicks`` row, so the increment commits even when
        the ``click_events`` table is unhealthy (missing columns, broken
        constraints, etc.).

        Uniqueness detection is best-effort: if querying ``click_events``
        fails, the click is conservatively counted as unique.
        """
        now = datetime.utcnow()
        async with async_session_maker() as session:
            is_unique = True
            if ip_address:
                try:
                    existing = await session.execute(
                        select(ClickEvent.id).where(
                            ClickEvent.link_id == link_id,
                            ClickEvent.ip_address == ip_address,
                        ).limit(1)
                    )
                    if existing.scalar_one_or_none() is not None:
                        is_unique = False
                except Exception:
                    logger.exception(
                        "bump_click_counter: unique check failed for link_id=%s; "
                        "treating click as unique",
                        link_id,
                    )
                    await session.rollback()

            unique_inc = 1 if is_unique else 0
            await session.execute(
                sa_update(LinkClick)
                .where(LinkClick.id == link_id)
                .values(
                    click_count=func.coalesce(LinkClick.click_count, 0) + 1,
                    unique_clicks=func.coalesce(LinkClick.unique_clicks, 0) + unique_inc,
                    last_clicked_at=now,
                    first_clicked_at=func.coalesce(LinkClick.first_clicked_at, now),
                )
            )
            await session.commit()

    async def insert_click_event(
        self,
        link_id: UUID,
        ip_address: Optional[str],
        user_agent_str: Optional[str],
        referrer: Optional[str],
        domain_id: Optional[UUID] = None,
    ) -> Optional[UUID]:
        """Insert a ClickEvent row in its own session. Returns event id on
        success, None on failure. Counter increments live in
        :meth:`bump_click_counter` so this can fail independently."""
        ua_info = parse_user_agent(user_agent_str or "")
        event_id = uuid4()

        # Clamp every VARCHAR field to its column length so a freakishly
        # long UA / Railway-edge IP chain can never raise
        # ``StringDataRightTruncation`` and lose the click event entirely.
        def _clip(value: Optional[str], length: int) -> Optional[str]:
            if value is None:
                return None
            return value[:length]

        async with async_session_maker() as session:
            event = ClickEvent(
                id=event_id,
                link_id=link_id,
                domain_id=domain_id,
                ip_address=_clip(ip_address, 45),
                user_agent=user_agent_str,
                referrer=referrer,
                device_type=_clip(ua_info["device_type"], 50),
                browser=_clip(ua_info["browser"], 100),
                os=_clip(ua_info["os"], 100),
            )
            session.add(event)
            await session.commit()
        return event_id

    async def record_file_view_event(
        self,
        file,
        ip_address: Optional[str],
        user_agent_str: Optional[str],
        referrer: Optional[str],
        session: AsyncSession,
        domain_id: Optional[UUID] = None,
    ) -> ClickEvent:
        """Record a view against a FileAsset, mirroring ``record_click_event``.

        Imported lazily to keep models.utm decoupled from models.file_asset.
        """
        from app.models.file_asset import FileAsset

        if not isinstance(file, FileAsset):
            raise TypeError("file must be a FileAsset instance")

        ua_info = parse_user_agent(user_agent_str or "")

        event = ClickEvent(
            id=uuid4(),
            link_id=None,
            file_id=file.id,
            domain_id=domain_id if domain_id is not None else file.domain_id,
            ip_address=ip_address,
            user_agent=user_agent_str,
            referrer=referrer,
            device_type=ua_info["device_type"],
            browser=ua_info["browser"],
            os=ua_info["os"],
        )
        session.add(event)

        now = datetime.utcnow()
        file.view_count = (file.view_count or 0) + 1
        file.last_viewed_at = now

        await session.flush()
        return event

    async def resolve_geo_for_event(self, event_id: UUID, ip_address: str) -> None:
        """Background task: resolve GeoIP + VPN/ASN detection and update click event."""
        from app.services.geoip_service import lookup_ip

        geo = await lookup_ip(ip_address)
        if not geo:
            return

        async with async_session_maker() as session:
            result = await session.execute(
                select(ClickEvent).where(ClickEvent.id == event_id)
            )
            event = result.scalar_one_or_none()
            if event:
                event.country = geo.get("country")
                event.country_code = geo.get("country_code")
                event.region = geo.get("region")
                event.city = geo.get("city")
                event.latitude = geo.get("latitude")
                event.longitude = geo.get("longitude")
                event.is_vpn = bool(geo.get("is_vpn")) if geo.get("is_vpn") is not None else False
                event.asn_org = geo.get("asn_org")
                await session.commit()

    # ------------------------------------------------------------------
    # Bulk CSV processing
    # ------------------------------------------------------------------

    async def process_bulk_csv(
        self,
        csv_content: str,
        default_params: Optional[Dict[str, str]] = None,
        *,
        user_id: Optional[str] = None,
        session: Optional[AsyncSession] = None,
        project_id: Optional[UUID] = None,
        short_link_builder: Optional[Any] = None,
    ) -> str:
        """Process a CSV of URLs and append UTM parameters.

        The input CSV must have a `url` column. It may also include
        utm_source, utm_medium, utm_campaign, utm_content, utm_term
        columns to override defaults per row.

        When ``user_id`` and ``session`` are provided, every row is
        persisted via :meth:`record_link` so each generated URL has a
        trackable short code. ``short_link_builder`` is an optional
        callable ``(short_code: str) -> str`` used to populate a
        ``short_link`` column in the output CSV.

        Returns CSV string with ``tracked_url``, ``short_link``, and
        ``error`` columns appended (``short_link`` left blank when
        tracking is not enabled).
        """
        default_params = default_params or {}
        track = user_id is not None and session is not None

        reader = csv.DictReader(io.StringIO(csv_content))
        if not reader.fieldnames or "url" not in reader.fieldnames:
            raise ValueError("CSV must contain a 'url' column")

        output_fields = list(reader.fieldnames) + ["tracked_url", "short_link", "error"]
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=output_fields)
        writer.writeheader()

        for row in reader:
            base_url = row.get("url", "").strip()
            row["error"] = ""
            row["tracked_url"] = ""
            row["short_link"] = ""

            if not base_url:
                row["error"] = "Missing URL"
                writer.writerow(row)
                continue

            if "." not in base_url and "localhost" not in base_url and not base_url.startswith("http"):
                row["error"] = "Invalid URL format"
                writer.writerow(row)
                continue

            params = dict(default_params)
            for key in UTM_KEYS:
                row_value = row.get(key, "").strip()
                if row_value:
                    params[key] = row_value

            try:
                tracked = self.generate_utm_url(base_url, params)
                row["tracked_url"] = tracked
            except Exception as e:
                row["error"] = f"Failed to generate: {str(e)}"
                writer.writerow(row)
                continue

            if track:
                try:
                    link = await self.record_link(
                        user_id=user_id,
                        original_url=base_url if base_url.startswith("http") else f"https://{base_url}",
                        tracked_url=tracked,
                        utm_params=params,
                        project_id=project_id,
                        session=session,
                    )
                    if link.short_code and short_link_builder is not None:
                        row["short_link"] = short_link_builder(link.short_code) or ""
                except Exception as e:
                    logger.exception("bulk: failed to persist trackable link for %s", base_url)
                    row["error"] = f"Tracking failed: {str(e)}"

            writer.writerow(row)

        return output.getvalue()

    # ------------------------------------------------------------------
    # Inject UTM params into HTML links
    # ------------------------------------------------------------------

    def inject_utm_into_html(
        self,
        html_body: str,
        utm_params: Dict[str, str],
        preserve_existing: bool = True,
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """Inject UTM parameters into all trackable links in HTML.

        Parameters
        ----------
        html_body : str
            HTML string containing anchor tags.
        utm_params : dict
            UTM parameters to inject.
        preserve_existing : bool
            If True, skip links that already contain utm_ query params.

        Returns
        -------
        tuple[str, list[dict]]
            (modified_html, links_metadata)
        """
        links_metadata: List[Dict[str, Any]] = []
        position_counter = 0

        link_pattern = re.compile(
            r'(<a\s[^>]*href=["\'])([^"\']+)(["\'][^>]*>)(.*?)(</a>)',
            re.IGNORECASE | re.DOTALL,
        )

        def _strip_tags(text: str) -> str:
            return re.sub(r"<[^>]+>", "", text).strip()

        def _replace_link(match: re.Match) -> str:
            nonlocal position_counter

            prefix = match.group(1)
            url = match.group(2)
            mid = match.group(3)
            inner = match.group(4)
            suffix = match.group(5)

            lower_url = url.lower()
            if any(lower_url.startswith(s) for s in ("mailto:", "tel:", "javascript:")):
                return match.group(0)

            if preserve_existing:
                parsed = urlparse(url)
                existing_qs = parse_qs(parsed.query)
                if any(k.startswith("utm_") for k in existing_qs):
                    return match.group(0)

            new_url = self.generate_utm_url(url, utm_params, preserve_existing=False)

            anchor_text = _strip_tags(inner)
            idx = position_counter
            position_counter += 1

            meta: Dict[str, Any] = {
                "original_url": url,
                "tracked_url": new_url,
                "anchor_text": anchor_text[:500] if anchor_text else None,
                "position": idx,
            }
            for utm_key in UTM_KEYS:
                meta[utm_key] = utm_params.get(utm_key)
            links_metadata.append(meta)

            return f"{prefix}{new_url}{mid}{inner}{suffix}"

        modified_html = link_pattern.sub(_replace_link, html_body)
        return modified_html, links_metadata

    # ------------------------------------------------------------------
    # Increment link click
    # ------------------------------------------------------------------

    async def increment_link_click(
        self,
        link_click_id: str,
    ) -> None:
        """Increment click counts for a tracked link.

        Parameters
        ----------
        link_click_id : str
            LinkClick UUID.
        """
        now = datetime.utcnow()

        async with async_session_maker() as session:
            result = await session.execute(
                select(LinkClick).where(LinkClick.id == link_click_id)
            )
            link_click = result.scalar_one_or_none()

            if link_click:
                was_zero = link_click.click_count == 0
                link_click.click_count = (link_click.click_count or 0) + 1
                link_click.last_clicked_at = now

                if was_zero:
                    link_click.unique_clicks = (link_click.unique_clicks or 0) + 1
                if link_click.first_clicked_at is None:
                    link_click.first_clicked_at = now

                await session.commit()
                logger.info("Link click incremented: id=%s", link_click_id)
            else:
                logger.warning("LinkClick not found: id=%s", link_click_id)


# Singleton instance
utm_service = UTMService()
