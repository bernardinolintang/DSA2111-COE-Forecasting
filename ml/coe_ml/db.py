"""PostgreSQL persistence for the pipeline (SQLAlchemy Core).

The schema itself lives in ``db/init.sql`` (copied into the image as
``schema.sql``) and is applied idempotently on start-up, so the pipeline can
bootstrap an empty database on its own — handy in Kubernetes where pod start
order is not guaranteed.
"""

from __future__ import annotations

import json
import logging
import socket
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import MetaData, Table, create_engine, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.engine import Engine

from . import config
from .policy_events import POLICY_EVENTS

log = logging.getLogger(__name__)

SCHEMA_CANDIDATES = [
    Path("/app/schema.sql"),                                   # inside the Docker image
    config.PACKAGE_DIR.parent.parent / "db" / "init.sql",      # repository checkout
]
KEEP_RUNS = 10          # older model runs are pruned to keep the database small


def get_engine(url: str | None = None) -> Engine:
    return create_engine(url or config.DATABASE_URL, pool_pre_ping=True)


def wait_for_db(engine: Engine, timeout_s: int = 90) -> None:
    """Block until Postgres accepts connections (containers start in any order)."""
    deadline = time.time() + timeout_s
    while True:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception as exc:
            if time.time() > deadline:
                raise RuntimeError(f"database not reachable after {timeout_s}s") from exc
            log.info("Waiting for database...")
            time.sleep(2)


def ensure_schema(engine: Engine) -> None:
    path = next((p for p in SCHEMA_CANDIDATES if p.exists()), None)
    if path is None:
        raise FileNotFoundError("schema.sql / db/init.sql not found")
    with engine.begin() as conn:
        conn.exec_driver_sql(path.read_text(encoding="utf-8"))


def _table(engine: Engine, name: str) -> Table:
    return Table(name, MetaData(), autoload_with=engine)


def _clean(value):
    """Convert numpy / pandas scalars into plain Python for the DB driver."""
    if isinstance(value, (np.floating, float)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, pd.Timestamp):
        return value.date()
    return value


def _records(df: pd.DataFrame) -> list[dict]:
    return [{k: _clean(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


def upsert(engine: Engine, table_name: str, df: pd.DataFrame, keys: list[str]) -> int:
    """INSERT ... ON CONFLICT (keys) DO UPDATE for every row of ``df``."""
    if df.empty:
        return 0
    table = _table(engine, table_name)
    rows = _records(df)
    stmt = insert(table)
    updates = {c.name: stmt.excluded[c.name] for c in table.columns if c.name in df.columns and c.name not in keys}
    stmt = stmt.on_conflict_do_update(index_elements=keys, set_=updates) if updates else stmt.on_conflict_do_nothing()
    with engine.begin() as conn:
        for start in range(0, len(rows), 2000):
            conn.execute(stmt, rows[start:start + 2000])
    return len(rows)


def insert_rows(engine: Engine, table_name: str, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    table = _table(engine, table_name)
    with engine.begin() as conn:
        conn.execute(table.insert(), _records(df))
    return len(df)


# ---------------------------------------------------------------------------
# Raw data
# ---------------------------------------------------------------------------
def save_raw_data(engine: Engine, coe: pd.DataFrame, macro: pd.DataFrame) -> None:
    n_coe = upsert(engine, "coe_results", coe, ["month", "bidding_no", "category"])
    n_macro = upsert(engine, "macro_indicators", macro, ["month", "indicator"])
    events = pd.DataFrame([{
        "code": e.code, "name": e.name, "effective_month": e.effective, "end_month": e.end,
        "kind": e.kind, "categories": e.categories, "description": e.description, "source_url": e.source_url,
    } for e in POLICY_EVENTS])
    upsert(engine, "policy_events", events, ["code"])
    log.info("Upserted %d COE rows, %d macro rows, %d policy events", n_coe, n_macro, len(events))


# ---------------------------------------------------------------------------
# Model runs
# ---------------------------------------------------------------------------
def start_run(engine: Engine, model_name: str, params: dict) -> int:
    with engine.begin() as conn:
        return conn.execute(
            text("INSERT INTO model_runs (model_name, params, host) VALUES (:m, CAST(:p AS JSONB), :h) RETURNING id"),
            {"m": model_name, "p": json.dumps(params), "h": socket.gethostname()},
        ).scalar_one()


def finish_run(engine: Engine, run_id: int, status: str, *, metrics: dict | None = None,
               data_through=None, last_bidding: int | None = None, duration_s: float | None = None,
               notes: str | None = None) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("""UPDATE model_runs SET status = :s, finished_at = :f, metrics = CAST(:m AS JSONB),
                    data_through = :d, last_bidding = :b, duration_s = :t, notes = :n WHERE id = :id"""),
            {"s": status, "f": datetime.now(timezone.utc), "m": json.dumps(metrics or {}),
             "d": data_through, "b": last_bidding, "t": duration_s, "n": notes, "id": run_id},
        )


def prune_runs(engine: Engine, keep: int = KEEP_RUNS) -> None:
    """Delete old runs, but always keep the latest fully evaluated one (with a backtest)."""
    with engine.begin() as conn:
        conn.execute(text("""
            DELETE FROM model_runs
            WHERE id NOT IN (SELECT id FROM model_runs ORDER BY id DESC LIMIT :k)
              AND id IS DISTINCT FROM (SELECT MAX(run_id) FROM backtest_metrics)"""), {"k": keep})


def last_evaluated_epochs(engine: Engine) -> int | None:
    """Epoch count chosen by cross-validation in the latest fully evaluated run."""
    with engine.connect() as conn:
        value = conn.execute(text("""
            SELECT (metrics ->> 'production_epochs')::int FROM model_runs
            WHERE status = 'succeeded' AND metrics ? 'diebold_mariano'
            ORDER BY id DESC LIMIT 1""")).scalar()
    return value


def save_outputs(engine: Engine, run_id: int, outputs: dict[str, pd.DataFrame]) -> None:
    """Insert every output table of one run (forecasts, metrics, diagnostics)."""
    for table_name, df in outputs.items():
        if df is None or df.empty:
            continue
        n = insert_rows(engine, table_name, df.assign(run_id=run_id))
        log.info("Wrote %d rows to %s", n, table_name)
