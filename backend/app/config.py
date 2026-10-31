"""Runtime settings, read once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


# this splits a comma list from an env var so that CORS origins can be set in one string
def _csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


# these are the default models per provider so that the analyst works with just an API key
ANALYST_DEFAULT_MODELS = {"groq": "openai/gpt-oss-120b", "anthropic": "claude-opus-5-5"}


# this keeps a custom model name to its own provider so that it never gets sent to the wrong API
def model_for(provider: str) -> str:
    """ANALYST_MODEL applies to the active provider only; any other provider uses its own default."""
    return (settings.analyst_model if settings.analyst_provider == provider else "") or ANALYST_DEFAULT_MODELS[provider]


def analyst_provider() -> str:
    """Which language model backs the COE Analyst: set a key in .env and it is picked up.

    ANALYST_PROVIDER forces a choice; otherwise GROQ_API_KEY -> groq, ANTHROPIC_API_KEY -> anthropic,
    neither -> offline (basic mode). A provider without its key also falls back to offline.
    """
    # this lets a demo or test force basic mode so that no API key is used
    if os.getenv("ANALYST_ENABLED", "true").lower() in ("0", "false", "no"):
        return "offline"
    # this checks which keys are set so that the analyst picks a provider that can really run
    has = {"groq": bool(os.getenv("GROQ_API_KEY")),
           "anthropic": bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))}
    explicit = os.getenv("ANALYST_PROVIDER", "").strip().lower()
    if explicit in has:
        return explicit if has[explicit] else "offline"
    return "groq" if has["groq"] else "anthropic" if has["anthropic"] else "offline"


# this holds the settings in one frozen object so that nothing can change them while the app runs
@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "postgresql+psycopg://coe:coe_password@localhost:5432/coe")
    # this is the size of drop that counts as meaningful (the outlook's "chance of a drop of 8% or
    # more"), it keeps its old variable name so that existing configs still work, the app never
    # issues a buy or wait call
    wait_threshold: float = float(os.getenv("WAIT_THRESHOLD", "0.08"))
    cors_origins: list[str] = field(default_factory=lambda: _csv(os.getenv("CORS_ORIGINS", "*")))
    max_alerts_per_client: int = int(os.getenv("MAX_ALERTS_PER_CLIENT", "20"))
    version: str = os.getenv("APP_VERSION", "1.0.0")

    # these are the COE Analyst settings. a language model is used only when its API key is on the
    # server (never in the browser), otherwise it answers in basic mode so that the feature still
    # works with no key
    analyst_provider: str = field(default_factory=analyst_provider)          # groq | anthropic | offline
    analyst_model: str = field(default_factory=lambda: os.getenv("ANALYST_MODEL", "").strip()
                               or ANALYST_DEFAULT_MODELS.get(analyst_provider(), ""))
    analyst_effort: str = os.getenv("ANALYST_EFFORT", "")          # low|medium|high; empty = model default
    analyst_timeout_s: float = float(os.getenv("ANALYST_TIMEOUT_S", "45"))
    analyst_rate_limit: int = int(os.getenv("ANALYST_RATE_LIMIT", "30"))   # questions per client per 10 min

    # this says if a language model is on so that other code does not have to compare strings
    @property
    def analyst_llm(self) -> bool:
        return self.analyst_provider != "offline"


# this builds the settings once so that the whole app shares them
settings = Settings()
