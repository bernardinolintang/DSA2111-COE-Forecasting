"""All SQL used by the API, in one place.

Functions take an open connection and return plain dicts / lists so routers
stay thin and the queries can be read (and tested) on their own.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import text
from sqlalchemy.engine import Connection


# this returns all rows as dicts so that callers do not depend on SQLAlchemy
def _all(conn: Connection, sql: str, **params) -> list[dict]:
    return [dict(r) for r in conn.execute(text(sql), params).mappings()]


# this returns one row as a dict or None so that callers can check for nothing found
def _one(conn: Connection, sql: str, **params) -> dict | None:
    row = conn.execute(text(sql), params).mappings().first()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------
# this finds the newest good run so that the app never serves a failed one
def latest_run(conn: Connection) -> dict | None:
    return _one(conn, """
        SELECT id, created_at, finished_at, model_name, data_through, last_bidding,
               params, metrics, duration_s
        FROM model_runs WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1""")


def latest_evaluated_run(conn: Connection) -> dict | None:
    """Latest successful run that includes a backtest (quick retrains skip it)."""
    return _one(conn, """
        SELECT r.id, r.created_at, r.finished_at, r.model_name, r.data_through, r.last_bidding,
               r.params, r.metrics, r.duration_s
        FROM model_runs r
        WHERE r.status = 'succeeded' AND EXISTS (SELECT 1 FROM backtest_metrics b WHERE b.run_id = r.id)
        ORDER BY r.id DESC LIMIT 1""")


# this lists recent runs so that the model page can show the history of retrains
def recent_runs(conn: Connection, limit: int = 10) -> list[dict]:
    return _all(conn, """
        SELECT id, created_at, finished_at, status, model_name, data_through, last_bidding,
               duration_s, host, notes
        FROM model_runs ORDER BY id DESC LIMIT :limit""", limit=limit)


# this reads one category's results, the date filter is optional so that the same query also gives
# the full history
def history(conn: Connection, category: str, since: date | None = None) -> list[dict]:
    return _all(conn, """
        SELECT month, bidding_no, premium, quota, bids_received, bids_success
        FROM coe_results
        WHERE category = :cat AND (CAST(:since AS DATE) IS NULL OR month >= :since)
        ORDER BY month, bidding_no""", cat=category, since=since)


# this numbers rows per category so that we can keep the last n exercises of each
def latest_exercises(conn: Connection, n: int = 25) -> list[dict]:
    """The last ``n`` exercises for every category (newest first per category)."""
    return _all(conn, """
        SELECT * FROM (
            SELECT category, month, bidding_no, premium, quota, bids_received, bids_success,
                   ROW_NUMBER() OVER (PARTITION BY category ORDER BY month DESC, bidding_no DESC) AS rn
            FROM coe_results) t
        WHERE rn <= :n ORDER BY category, rn""", n=n)


# this finds the same exercise a year ago so that the card can show yearly change
def premium_year_ago(conn: Connection, category: str, month: date, bidding_no: int) -> int | None:
    row = _one(conn, """
        SELECT premium FROM coe_results
        WHERE category = :cat AND month = (CAST(:month AS DATE) - INTERVAL '1 year') AND bidding_no = :b""",
               cat=category, month=month, b=bidding_no)
    return row["premium"] if row else None


# this reads macro series from a start date so that the charts stay small
def macro(conn: Connection, since: date) -> list[dict]:
    return _all(conn, """
        SELECT month, indicator, value FROM macro_indicators
        WHERE month >= :since ORDER BY indicator, month""", since=since)


# ---------------------------------------------------------------------------
# Forecasts
# ---------------------------------------------------------------------------
# this reads one forecast path so that a page gets all 6 steps in order
def forecast(conn: Connection, run_id: int, category: str, scenario: str) -> list[dict]:
    return _all(conn, """
        SELECT step, month, bidding_no, quota, q05, q10, q25, q50, q75, q90, q95
        FROM forecasts WHERE run_id = :run AND category = :cat AND scenario = :sc
        ORDER BY step""", run=run_id, cat=category, sc=scenario)


# this reads every category's forecast in one query so that the summary does not run five
def forecasts_all(conn: Connection, run_id: int, scenario: str = "base") -> list[dict]:
    return _all(conn, """
        SELECT category, step, month, bidding_no, quota, q05, q10, q25, q50, q75, q90, q95
        FROM forecasts WHERE run_id = :run AND scenario = :sc ORDER BY category, step""",
                run=run_id, sc=scenario)


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------
# this reads the policy events by date so that the Policy Lab shows them in order
def policy_events(conn: Connection) -> list[dict]:
    return _all(conn, "SELECT * FROM policy_events ORDER BY effective_month")


# this reads the Box-Tiao effects of a run so that the page can show them per category
def intervention_effects(conn: Connection, run_id: int) -> list[dict]:
    return _all(conn, """
        SELECT event_code, category, omega, std_err, p_value, pct_effect, pct_low, pct_high
        FROM intervention_effects WHERE run_id = :run ORDER BY event_code, category""", run=run_id)


# ---------------------------------------------------------------------------
# Model diagnostics
# ---------------------------------------------------------------------------
# this reads the backtest scores so that the router can build the leaderboard
def backtest_metrics(conn: Connection, run_id: int) -> list[dict]:
    return _all(conn, "SELECT * FROM backtest_metrics WHERE run_id = :run", run=run_id)


# this reads predicted against actual so that the model page can draw the chart
def backtest_predictions(conn: Connection, run_id: int, category: str, model: str, horizon: int) -> list[dict]:
    return _all(conn, """
        SELECT month, bidding_no, horizon, actual, q10, q50, q90
        FROM backtest_predictions
        WHERE run_id = :run AND category = :cat AND model = :model AND horizon = :h
        ORDER BY month, bidding_no""", run=run_id, cat=category, model=model, h=horizon)


# this reads the TFT importance weights so that the chart shows the strongest first
def variable_importance(conn: Connection, run_id: int) -> list[dict]:
    return _all(conn, """
        SELECT component, variable, importance FROM variable_importance
        WHERE run_id = :run ORDER BY component, importance DESC""", run=run_id)


# this reads the attention weights so that the chart can show which past exercises mattered
def attention(conn: Connection, run_id: int) -> list[dict]:
    return _all(conn, """
        SELECT category, lag, weight FROM attention_weights
        WHERE run_id = :run ORDER BY category, lag""", run=run_id)


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------
# this lists one client's alerts so that the newest shows first
def list_alerts(conn: Connection, client_id: str) -> list[dict]:
    return _all(conn, """
        SELECT id, category, direction, target, label, created_at
        FROM price_alerts WHERE client_id = :cid ORDER BY created_at DESC""", cid=client_id)


# this counts a client's alerts so that the limit can be enforced
def count_alerts(conn: Connection, client_id: str) -> int:
    return conn.execute(text("SELECT COUNT(*) FROM price_alerts WHERE client_id = :cid"),
                        {"cid": client_id}).scalar_one()


def find_alert(conn: Connection, client_id: str, category: str, direction: str, target: int) -> dict | None:
    """An identical alert (same client, category, direction and target), if one exists."""
    return _one(conn, """
        SELECT id FROM price_alerts
        WHERE client_id = :cid AND category = :cat AND direction = :dir AND target = :target
        LIMIT 1""", cid=client_id, cat=category, dir=direction, target=target)


# this saves a new alert and commits so that it survives the end of the request
def create_alert(conn: Connection, client_id: str, category: str, direction: str,
                 target: int, label: str | None) -> dict:
    row = _one(conn, """
        INSERT INTO price_alerts (client_id, category, direction, target, label)
        VALUES (:cid, :cat, :dir, :target, :label)
        RETURNING id, category, direction, target, label, created_at""",
               cid=client_id, cat=category, dir=direction, target=target, label=label)
    conn.commit()
    return row


# this deletes only when the client id matches so that nobody can remove someone else's alert
def delete_alert(conn: Connection, alert_id: int, client_id: str) -> bool:
    deleted = conn.execute(text("DELETE FROM price_alerts WHERE id = :id AND client_id = :cid"),
                           {"id": alert_id, "cid": client_id}).rowcount
    conn.commit()
    return deleted > 0
