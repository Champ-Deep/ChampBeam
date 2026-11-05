"""Assistant configuration: provider choice + model + enabled flag.

Singleton row (id = 1). Keys never live here; the env holds them so the UI's
``*_configured`` flags come from settings, and switching providers is just a
config update plus an env key.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String

from app.db.postgres import Base

ASSISTANT_PROVIDER_OPENROUTER = "openrouter"
ASSISTANT_PROVIDER_VERCEL = "vercel"
ASSISTANT_PROVIDER_MOCK = "mock"
ASSISTANT_PROVIDERS = frozenset(
    {ASSISTANT_PROVIDER_OPENROUTER, ASSISTANT_PROVIDER_VERCEL, ASSISTANT_PROVIDER_MOCK}
)

# Default free models per provider, offered in the admin UI for testing.
SUGGESTED_FREE_MODELS: dict[str, list[str]] = {
    ASSISTANT_PROVIDER_OPENROUTER: [
        "meta-llama/llama-3.3-70b-instruct:free",
        "deepseek/deepseek-chat-v3-0324:free",
        "qwen/qwen-2.5-72b-instruct:free",
        "google/gemini-2.0-flash-exp:free",
    ],
    # On the Vercel AI Gateway the model name is the routing name for the
    # upstream you connected a key for; cost depends on that upstream.
    ASSISTANT_PROVIDER_VERCEL: [
        "google/gemini-2.5-flash",
        "openai/gpt-4o-mini",
        "anthropic/claude-3-5-haiku-latest",
        "meta-llama/llama-3.3-70b-instruct",
    ],
}


class AssistantConfig(Base):
    __tablename__ = "assistant_config"

    id = Column(Integer, primary_key=True, default=1)
    provider = Column(String(32), nullable=False, default=ASSISTANT_PROVIDER_OPENROUTER)
    model = Column(String(160), nullable=False, default="meta-llama/llama-3.3-70b-instruct:free")
    enabled = Column(Boolean, nullable=False, default=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)