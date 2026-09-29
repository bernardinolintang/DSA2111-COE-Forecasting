"""Integration tests against a real Postgres populated by the ML pipeline.

Run inside docker compose:
    docker compose run --rm api pytest -q tests
They are skipped automatically when no database is reachable.
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import engine
from app.main import app


def _database_ready() -> bool:
    try:
        with engine.connect() as conn:
            return conn.execute(text("SELECT COUNT(*) FROM model_runs WHERE status = 'succeeded'")).scalar() > 0
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _database_ready(), reason="needs Postgres with at least one model run")


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["latest_run"] is not None


def test_summary_has_all_categories(client):
    body = client.get("/api/summary").json()
    assert [c["code"] for c in body["categories"]] == ["A", "B", "C", "D", "E"]
    assert all(c["signal"]["action"] in ("wait", "buy_now") for c in body["categories"])


@pytest.mark.parametrize("scenario", ["base", "quota_plus_20", "quota_minus_20"])
def test_forecast_quantiles_are_ordered(client, scenario):
    steps = client.get(f"/api/forecast/A?scenario={scenario}").json()["steps"]
    assert len(steps) == 6
    for s in steps:
        assert s["q05"] <= s["q10"] <= s["q25"] <= s["q50"] <= s["q75"] <= s["q90"] <= s["q95"]


def test_more_supply_does_not_raise_prices(client):
    low = client.get("/api/forecast/B?scenario=quota_minus_20").json()["steps"][-1]["q50"]
    high = client.get("/api/forecast/B?scenario=quota_plus_20").json()["steps"][-1]["q50"]
    assert high <= low * 1.02


def test_bid_planner_probability_increases_with_bid(client):
    curve = client.get("/api/bid-planner/A").json()["curve"]
    probs = [p["probability_pct"] for p in curve]
    assert probs == sorted(probs)


def test_unknown_category_is_404(client):
    assert client.get("/api/forecast/Z").status_code == 404


def test_policy_and_model_endpoints(client):
    assert len(client.get("/api/policy/events").json()) >= 5
    assert client.get("/api/model/metrics").json()["leaderboard"]
    assert client.get("/api/model/interpretability").json()["encoder"]
    assert client.get("/api/model/backtest/A?model=tft&horizon=1").json()["points"]


def test_alert_lifecycle(client):
    cid = str(uuid.uuid4())
    created = client.post("/api/alerts", json={"client_id": cid, "category": "A", "direction": "below",
                                               "target": 90000})
    assert created.status_code == 201
    alert = created.json()
    assert alert["status"] in ("triggered", "likely", "possible", "unlikely")
    assert len(client.get(f"/api/alerts?client_id={cid}").json()) == 1
    assert client.delete(f"/api/alerts/{alert['id']}?client_id={cid}").status_code == 204
    assert client.get(f"/api/alerts?client_id={cid}").json() == []
