"""
UTM Service for ChampUTM.

Handles URL generation, bulk CSV processing, and click tracking.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.postgres import async_session_maker
from app.models.utm import LinkClick, UTMPreset

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
            Optional project grouping.
        session : AsyncSession or None
            Database session. Opens a new one if not provided.

        Returns
        -------
        LinkClick
            The created record.
        """
        # Ensure unique short code
        s_code = self._generate_short_code()

        link = LinkClick(
            id=uuid4(),
            user_id=user_id,
            project_name=project_name,
            original_url=original_url,
            tracked_url=tracked_url,
            short_code=s_code,
            utm_source=utm_params.get("utm_source"),
            utm_medium=utm_params.get("utm_medium"),
            utm_campaign=utm_params.get("utm_campaign"),
            utm_content=utm_params.get("utm_content"),
            utm_term=utm_params.get("utm_term"),
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

    # ------------------------------------------------------------------
    # Bulk CSV processing
    # ------------------------------------------------------------------

    def process_bulk_csv(
        self,
        csv_content: str,
        default_params: Optional[Dict[str, str]] = None,
    ) -> str:
        """Process a CSV of URLs and append UTM parameters.

        The input CSV must have a `url` column. It may also include
        utm_source, utm_medium, utm_campaign, utm_content, utm_term
        columns to override defaults per row.

        Parameters
        ----------
        csv_content : str
            Raw CSV string.
        default_params : dict or None
            Default UTM params applied when row-level values are empty.

        Returns
        -------
        str
            CSV string with a `tracked_url` column appended.
        """
        default_params = default_params or {}

        reader = csv.DictReader(io.StringIO(csv_content))
        if not reader.fieldnames or "url" not in reader.fieldnames:
            raise ValueError("CSV must contain a 'url' column")

        output_fields = list(reader.fieldnames) + ["tracked_url", "error"]
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=output_fields)
        writer.writeheader()

        for row_num, row in enumerate(reader, start=2): # Header is line 1
            base_url = row.get("url", "").strip()
            row["error"] = ""
            row["tracked_url"] = ""

            if not base_url:
                row["error"] = "Missing URL"
                writer.writerow(row)
                continue

            # Basic validation
            # urlparse adds https:// automatically below during generate, but if it has no netloc and no valid path...
            # A better heuristic for CSV is if it doesn't look like a valid URL or domain
            if "." not in base_url and "localhost" not in base_url and not base_url.startswith("http"):
                row["error"] = "Invalid URL format"
                writer.writerow(row)
                continue

            # Row-level UTM params override defaults
            params = dict(default_params)
            for key in UTM_KEYS:
                row_value = row.get(key, "").strip()
                if row_value:
                    params[key] = row_value

            try:
                row["tracked_url"] = self.generate_utm_url(base_url, params)
            except Exception as e:
                row["error"] = f"Failed to generate: {str(e)}"

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
