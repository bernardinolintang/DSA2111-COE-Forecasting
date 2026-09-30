"""Integration tests against a real Postgres populated by the ML pipeline.

Run inside docker compose:
    docker compose run --rm api pytest -q tests
They are skipped automatically when no database is reachable.
"""

import json
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
    for c in body["categories"]:
        s = c["signal"]
        assert s["conviction"] in ("high", "medium", "low")
        assert s["label"] in ("Buy now", "Lean buy", "Wait", "Lean wait")
        assert s["prob_higher_pct"] == pytest.approx(100 - s["prob_lower_pct"], abs=0.11)


def test_recommendation_matches_summary_signal(client):
    """The overview card and the forecast page must never disagree."""
    cards = {c["code"]: c["signal"] for c in client.get("/api/summary").json()["categories"]}
    for code, signal in cards.items():
        rec = client.get(f"/api/recommendation/{code}").json()
        assert (rec["action"], rec["label"], rec["conviction"]) == (signal["action"], signal["label"], signal["conviction"])


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


def test_alert_shows_forecast_context_and_rejects_duplicates_and_bad_targets(client):
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "category": "B", "direction": "below", "target": 100000}
    first = client.post("/api/alerts", json=body)
    assert first.status_code == 201
    alert = first.json()
    assert alert["next_label"] and alert["next_q50"] > 0 and alert["horizon_label"]
    dup = client.post("/api/alerts", json=body)
    assert dup.status_code == 409 and "already watching" in dup.json()["detail"]
    for bad in (0, -200, "abc", None, 1_000_000):
        assert client.post("/api/alerts", json={**body, "target": bad}).status_code == 422
    client.delete(f"/api/alerts/{alert['id']}?client_id={cid}")


# ---------------------------------------------------------------------------
# COE Analyst (these run in basic mode unless ANTHROPIC_API_KEY is set)
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def basic_mode(monkeypatch):
    """Keep these tests deterministic and free: never call a real LLM, even if a key is configured."""
    import dataclasses

    from app.routers import analyst as analyst_router
    monkeypatch.setattr(analyst_router, "settings", dataclasses.replace(analyst_router.settings, analyst_provider="offline"))


def _ask(client, question, **view):
    return client.post("/api/analyst/chat", json={"messages": [{"role": "user", "content": question}],
                                                  "view": view, "client_id": str(uuid.uuid4())})


def test_glossary_and_status(client):
    terms = {t["id"]: t for t in client.get("/api/glossary").json()}
    assert {"range-80", "significance", "box-tiao", "conviction", "smape", "attention"} <= set(terms)
    assert client.get("/api/analyst/status").json()["mode"] in ("llm", "offline")


def test_analyst_navigation_and_provenance(client):
    res = _ask(client, "Show me Cat E", page="overview")
    assert res.status_code == 200
    body = res.json()
    nav = [a for a in body["actions"] if a["type"] == "navigate"]
    assert nav and nav[0]["params"]["page"] == "forecast" and nav[0]["params"]["category"] == "E"
    assert body["provenance"] and "bidding exercise" in body["provenance"]


def test_analyst_alert_requests_need_confirmation(client):
    body = _ask(client, "Alert me when Cat A falls below $110k", page="alerts").json()
    drafts = [a for a in body["actions"] if a["type"] == "prepare_watch"]
    assert drafts and all(a["confirm"] for a in drafts)
    assert drafts[0]["params"]["target"] == 110000


def test_analyst_streams_server_sent_events(client):
    body = {"messages": [{"role": "user", "content": "Show me Cat E"}], "view": {"page": "overview"}}
    with client.stream("POST", "/api/analyst/chat?stream=1", json=body) as res:
        assert res.status_code == 200 and res.headers["content-type"].startswith("text/event-stream")
        raw = "".join(res.iter_text())
    events = [block.split("\n") for block in raw.strip().split("\n\n")]
    kinds = [lines[0].removeprefix("event: ") for lines in events]
    assert kinds[0] == "status" and "delta" in kinds and kinds[-1] == "done"
    done = json.loads(events[-1][1].removeprefix("data: "))
    assert done["actions"][0]["params"] == {"page": "forecast", "category": "E"}
    assert done["mode"] in ("llm", "offline") and done["provenance"]


def test_analyst_validates_requests(client):
    assert client.post("/api/analyst/chat", json={"messages": []}).status_code == 422
    too_long = [{"role": "user", "content": "x" * 1001}]
    assert client.post("/api/analyst/chat", json={"messages": too_long}).status_code == 422
    bad_view = {"messages": [{"role": "user", "content": "hi"}], "view": {"page": "admin"}}
    assert client.post("/api/analyst/chat", json=bad_view).status_code == 422
