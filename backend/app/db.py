"""Database engine and helpers.

The API uses plain SQL through SQLAlchemy Core: every query is visible in
services/repository.py, which makes it easy to follow and to explain.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine

from .config import settings

log = logging.getLogger(__name__)

engine: Engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=5, max_overflow=5)

SCHEMA_CANDIDATES = [Path("/app/schema.sql"), Path(__file__).resolve().parents[2] / "db" / "init.sql"]


def get_connection():
    """FastAPI dependency: one pooled connection per request."""
    with engine.connect() as conn:
        yield conn


def wait_and_migrate(timeout_s: int = 60) -> None:
    """Wait for Postgres, then apply the idempotent schema."""
    deadline = time.time() + timeout_s
    while True:
        try:
            with engine.begin() as conn:
                conn.execute(text("SELECT 1"))
                path = next((p for p in SCHEMA_CANDIDATES if p.exists()), None)
                if path is not None:
                    conn.exec_driver_sql(path.read_text(encoding="utf-8"))
            return
        except Exception as exc:
            if time.time() > deadline:
                log.error("Database unavailable: %s", exc)
                return            # start anyway; /api/health reports the problem
            log.info("Waiting for database...")
            time.sleep(2)


def ping(conn: Connection) -> bool:
    try:
        conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
