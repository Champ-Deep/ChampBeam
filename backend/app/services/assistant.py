"""Backend assistant: a guided feature helper for the product, provider-swappable.

The assistant is not a generic chatbot: its job is to help a signed-in user
understand Champbeam's features, why each one matters for them, and how to
find and actually use them, in a short, fun, guided way (per the product brief
Deep wrote). The system prompt below is the whole product of that brief, plus
a compact feature map and the user's current usage counts (links / files /
pages) so suggestions land on what they have NOT tried yet.

Providers: OpenRouter (default) and Vercel AI Gateway, both OpenAI-compatible
chat-completions endpoints, plus a deterministic ``mock`` provider for tests
and local dev without keys. Keys come from the environment; which provider and
model are active comes from the assistant_config singleton row (admin-editable
via PUT /api/v1/assistant/config).
"""

from __future__ import annotations

import json
import logging
from typing import Optional

import httpx

from app.core.config import settings
from app.models.assistant_config import (
    ASSISTANT_PROVIDER_MOCK,
    ASSISTANT_PROVIDER_OPENROUTER,
    ASSISTANT_PROVIDER_VERCEL,
    AssistantConfig,
)

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# A chat message as the providers accept it: {"role": ..., "content": ...}.
ChatMessage = dict


class AssistantError(Exception):
    """Upstream/provider failure with a status code for the API layer."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _system_prompt(user_overview: Optional[dict]) -> str:
    """The assistant's whole personality + knowledge, per Deep's brief:
    understand the features, suggest things to try, explain why they help,
    and guide the user to the exact place to use them, in a fun way."""
    counts = user_overview or {}
    return f"""You are Champ, the friendly guide inside Champbeam (a link, file and page sharing platform with tracking). Your only job is to help the signed-in user understand Champbeam's features, why each one is useful for THEM, and how to find and use them, in a short, fun, guided way. You are not a general-purpose assistant: keep answers about Champbeam and how to get things done with it.

House style:
- Short answers (2-5 sentences usually). One tiny emoji at most. No walls of text.
- Suggest exactly ONE next thing to try at the end, phrased as an action ("Try: ...").
- When the user names a goal, map it to the smallest feature that achieves it and give the exact UI location (sidebar item or generator step).
- Never invent features, buttons, or URLs. If you do not know, say so and point at the Pages or Links sections of the app.
- Be warm and a little playful; never corporate.

Feature map (what / why / where):
- Generator (home): paste any link to get a short tracked link plus QR code; every open is counted with device, location and browser. Great before you send anything important.
- Named links: give a link a readable name (e.g. /s/summit) in the Generator's "Link name" field, or rename later from Links. Useful when you will share the same link repeatedly and want it recognisable.
- Files: drop a PDF/image/video into "Share a file" and get a trackable link with a live read receipt (Seen / Not opened yet). Perfect for sales assets and follow-ups.
- Pages: publish a single HTML file (checklist, dashboard, proposal) at a clean /p/ address with view, revisit and dwell tracking, versions you can roll back, and an optional 4-8 digit access code. Beam State gives the page shared comments and checklist state without any backend.
- Publish a set: drop several HTML files together; Champbeam publishes them as pages AND rewrites their links to each other into the clean /p/ URLs automatically. Use for multi-page plans, funnels, dashboards with subpages.
- Links panel on any page: see every link inside that page and reroute any of them (or auto-map old /f/ links to your pages) without editing HTML; changes become a new version you can roll back.
- UTM: tag links with source/medium/campaign (presets in Links > folder or Generator), bulk-generate from a CSV, or use "Add UTM parameters to your links" on the Links page for tagged URLs with NO short link or tracking (for ad platforms).
- Analytics: per link, file and page: views, unique, revisits, dwell, geo map, devices. From any row's Analytics button.
- Custom domains: host your links/pages on your own domain from Settings > Custom domains.
- Teams: admins curate a shared content library; members mint their own tracked links from it; Team Analytics rolls engagement up per content item.

The user's current usage (do not repeat verbatim, just use it to guide):
- Tracked links: {counts.get('links', 0)}
- Files shared: {counts.get('files', 0)}
- Pages published: {counts.get('pages', 0)}

If they have used almost nothing, lean on the generator and one small win. If they are clearly a power user (lots of links/files/pages), skip the basics and offer the deeper tools (publish a set, reroute panel, access codes, UTM append mode)."""


def build_messages(
    history: list[ChatMessage], user_overview: Optional[dict] = None
) -> list[ChatMessage]:
    """System prompt + trimmed history, ready for any OpenAI-compatible API."""
    trimmed = history[-settings.assistant_max_history :]
    return [{"role": "system", "content": _system_prompt(user_overview)}, *trimmed]


class _OpenAICompatibleTransport:
    """Shared request logic for OpenRouter and the Vercel AI Gateway."""

    def __init__(self, url: str, api_key: str):
        self._url = url
        self._api_key = api_key

    async def complete(
        self,
        messages: list[ChatMessage],
        model: str,
        *,
        max_tokens: int,
        timeout_s: float,
    ) -> tuple[str, dict]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
        }
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                resp = await client.post(self._url, headers=headers, json=body)
        except httpx.TimeoutException:
            raise AssistantError(504, "The model provider timed out. Try again in a moment.")
        except httpx.HTTPError as exc:
            logger.warning("assistant: transport error: %s", exc)
            raise AssistantError(502, "Could not reach the model provider.")

        if resp.status_code != 200:
            raise self._map_error(resp)

        try:
            data = resp.json()
            reply = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            logger.warning("assistant: unexpected provider payload: %s", exc)
            raise AssistantError(502, "Unexpected response from the model provider.")

        usage = data.get("usage") or {}
        return str(reply or ""), {
            "prompt_tokens": int(usage.get("prompt_tokens", 0)),
            "completion_tokens": int(usage.get("completion_tokens", 0)),
        }

    def _map_error(self, resp: httpx.Response) -> AssistantError:
        detail = (resp.text or "")[:240]
        if resp.status_code == 401:
            return AssistantError(502, "Provider key rejected (401). Check the key in Settings.")
        if resp.status_code == 402:
            return AssistantError(402, "The model provider needs credits/billing (402).")
        if resp.status_code == 403:
            return AssistantError(403, "The provider refused this model (403). Try a free model.")
        if resp.status_code == 429:
            return AssistantError(429, "Provider is rate-limiting. Wait a bit and retry.")
        logger.warning("assistant: provider %s: %s", resp.status_code, detail)
        return AssistantError(502, f"Model provider error ({resp.status_code}).")


class OpenRouterProvider(_OpenAICompatibleTransport):
    def __init__(self):
        # OpenRouter picks the strongest non-free model as fallback when a
        # ":free" model is overloaded; that behavior is left to the provider.
        super().__init__(OPENROUTER_URL, settings.assistant_openrouter_api_key)


class VercelGatewayProvider(_OpenAICompatibleTransport):
    def __init__(self):
        url = settings.assistant_vercel_gateway_url.rstrip("/") + "/chat/completions"
        super().__init__(url, settings.assistant_vercel_api_key)


class MockProvider:
    """Deterministic stand-in for tests and keyless dev setups."""

    async def complete(
        self,
        messages: list[ChatMessage],
        model: str,
        *,
        max_tokens: int,
        timeout_s: float,
    ) -> tuple[str, dict]:
        last_user = next(
            (m["content"] for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"),
            "",
        )
        reply = (
            f"[mock:{model}] Good question! You asked: {str(last_user)[:120]}. "
            "On Champbeam you can tag links with UTM, share files with read receipts, "
            "and publish tracked HTML pages. Try the Generator to start."
        )
        return reply, {"prompt_tokens": 0, "completion_tokens": 0}


def provider_for(provider_id: str):
    """Instantiate the provider named in the config row."""
    if provider_id == ASSISTANT_PROVIDER_OPENROUTER:
        return OpenRouterProvider()
    if provider_id == ASSISTANT_PROVIDER_VERCEL:
        return VercelGatewayProvider()
    if provider_id == ASSISTANT_PROVIDER_MOCK:
        return MockProvider()
    raise AssistantError(400, f"Unknown assistant provider '{provider_id}'.")


def provider_configured(provider_id: str) -> bool:
    """Can this provider actually be called right now (key present)?"""
    if provider_id == ASSISTANT_PROVIDER_MOCK:
        return True
    if provider_id == ASSISTANT_PROVIDER_OPENROUTER:
        return settings.assistant_openrouter_configured
    if provider_id == ASSISTANT_PROVIDER_VERCEL:
        return settings.assistant_vercel_configured
    return False


async def config_row(session) -> AssistantConfig:
    """The singleton config row, creating it from env defaults if absent."""
    from sqlalchemy import select

    row = (
        await session.execute(
            select(AssistantConfig).where(AssistantConfig.id == 1)
        )
    ).scalar_one_or_none()
    if row is None:
        row = AssistantConfig(
            id=1,
            provider=settings.assistant_provider,
            model=settings.assistant_model,
            enabled=settings.assistant_enabled,
        )
        session.add(row)
        await session.flush()
    return row