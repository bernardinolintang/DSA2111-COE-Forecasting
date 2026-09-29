"""Runtime settings, read once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "postgresql+psycopg://coe:coe_password@localhost:5432/coe")
    # "Wait" when the median forecast for next quarter is at least this much below today's premium.
    wait_threshold: float = float(os.getenv("WAIT_THRESHOLD", "0.08"))
    cors_origins: list[str] = field(default_factory=lambda: _csv(os.getenv("CORS_ORIGINS", "*")))
    max_alerts_per_client: int = int(os.getenv("MAX_ALERTS_PER_CLIENT", "20"))
    version: str = os.getenv("APP_VERSION", "1.0.0")


settings = Settings()
