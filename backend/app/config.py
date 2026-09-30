"""Runtime settings, read once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


ANALYST_DEFAULT_MODELS = {"groq": "openai/gpt-oss-120b", "anthropic": "claude-opus-5-5"}


def model_for(provider: str) -> str:
    """ANALYST_MODEL applies to the active provider only; any other provider uses its own default."""
    return (settings.analyst_model if settings.analyst_provider == provider else "") or ANALYST_DEFAULT_MODELS[provider]


def analyst_provider() -> str:
    """Which language model backs the COE Analyst: set a key in .env and it is picked up.

    ANALYST_PROVIDER forces a choice; otherwise GROQ_API_KEY -> groq, ANTHROPIC_API_KEY -> anthropic,
    neither -> offline (basic mode). A provider without its key also falls back to offline.
    """
    if os.getenv("ANALYST_ENABLED", "true").lower() in ("0", "false", "no"):
        return "offline"
    has = {"groq": bool(os.getenv("GROQ_API_KEY")),
           "anthropic": bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))}
    explicit = os.getenv("ANALYST_PROVIDER", "").strip().lower()
    if explicit in has:
        return explicit if has[explicit] else "offline"
    return "groq" if has["groq"] else "anthropic" if has["anthropic"] else "offline"


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "postgresql+psycopg://coe:coe_password@localhost:5432/coe")
    # "Wait" when the median forecast for next quarter is at least this much below today's premium.
    wait_threshold: float = float(os.getenv("WAIT_THRESHOLD", "0.08"))
    cors_origins: list[str] = field(default_factory=lambda: _csv(os.getenv("CORS_ORIGINS", "*")))
    max_alerts_per_client: int = int(os.getenv("MAX_ALERTS_PER_CLIENT", "20"))
    version: str = os.getenv("APP_VERSION", "1.0.0")

    # COE Analyst. A language model is used only when its API key is configured on the server
    # (never in the browser); otherwise the analyst answers in basic (offline) mode.
    analyst_provider: str = field(default_factory=analyst_provider)          # groq | anthropic | offline
    analyst_model: str = field(default_factory=lambda: os.getenv("ANALYST_MODEL", "").strip()
                               or ANALYST_DEFAULT_MODELS.get(analyst_provider(), ""))
    analyst_effort: str = os.getenv("ANALYST_EFFORT", "")          # low|medium|high; empty = model default
    analyst_timeout_s: float = float(os.getenv("ANALYST_TIMEOUT_S", "45"))
    analyst_rate_limit: int = int(os.getenv("ANALYST_RATE_LIMIT", "30"))   # questions per client per 10 min

    @property
    def analyst_llm(self) -> bool:
        return self.analyst_provider != "offline"


settings = Settings()
