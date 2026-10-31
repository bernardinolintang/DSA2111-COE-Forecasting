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


# this checks for a finished run so that these tests skip when there is no database
def _database_ready() -> bool:
    try:
        with engine.connect() as conn:
            return conn.execute(text("SELECT COUNT(*) FROM model_runs WHERE status = 'succeeded'")).scalar() > 0
    except Exception:
        return False


# this applies the skip to the whole file so that each test does not need to check
pytestmark = pytest.mark.skipif(not _database_ready(), reason="needs Postgres with at least one model run")


# this shares one test client so that the app only starts once per file
@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# this checks the health route so that Docker and Kubernetes get a good answer
def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["latest_run"] is not None


# this checks every category card is complete so that the home page never misses a field
def test_summary_has_all_categories(client):
    body = client.get("/api/summary").json()
    assert [c["code"] for c in body["categories"]] == ["A", "B", "C", "D", "E"]
    assert body["next_exercise"]["label"] and body["run"]["finished_at"]
    for c in body["categories"]:
        s = c["signal"]
        assert s["outlook"] in ("easing", "softer", "steady", "firmer", "rising")
        assert s["label"] in ("Downward pressure", "Slight downward pressure", "No clear direction",
                              "Slight upward pressure", "Upward pressure")
        assert s["uncertainty"] in ("low", "moderate", "high")
        assert s["prob_higher_pct"] == pytest.approx(100 - s["prob_lower_pct"], abs=0.11)
        assert {d["key"] for d in s["drivers"]} == {"demand", "quota", "uncertainty"}
        assert c["next_label"] == body["next_exercise"]["label"]
        assert c["next_q10"] <= c["next_q50"] <= c["next_q90"]
        # this keeps the wording neutral so that the app never gives a buy or wait call
        assert "buy" not in s["summary"].lower() and "wait" not in s["summary"].lower()


# this compares two routes so that the home page and Forecast page always agree
def test_recommendation_matches_summary_signal(client):
    """The overview card and the forecast page must never disagree."""
    cards = {c["code"]: c["signal"] for c in client.get("/api/summary").json()["categories"]}
    for code, signal in cards.items():
        rec = client.get(f"/api/recommendation/{code}").json()
        assert {k: rec[k] for k in signal} == signal


# this checks the slider maths so that in-between values really are interpolated
def test_quota_pct_interpolates_between_modelled_scenarios(client):
    end = lambda query: client.get(f"/api/forecast/A?{query}").json()["steps"][-1]  # noqa: E731
    plus10, plus15, plus20 = end("scenario=quota_plus_10"), end("quota_pct=15"), end("scenario=quota_plus_20")
    assert end("quota_pct=10") == plus10
    assert plus15["q50"] == pytest.approx((plus10["q50"] + plus20["q50"]) / 2)
    assert plus15["quota"] == round((plus10["quota"] + plus20["quota"]) / 2)
    body = client.get("/api/forecast/A?quota_pct=15").json()
    assert (body["scenario"], body["quota_pct"]) == ("custom", 15)
    assert client.get("/api/forecast/A?quota_pct=-20").json()["scenario"] == "quota_minus_20"
    assert client.get("/api/recommendation/A?quota_pct=15").json()["quota_pct"] == 15
    assert client.get("/api/forecast/A?quota_pct=25").status_code == 422        # never extrapolated
    assert {s["quota_pct"] for s in client.get("/api/scenarios").json()} == {-20, -10, 0, 10, 20}


# this checks the quantiles stay in order so that the ranges on screen make sense
@pytest.mark.parametrize("scenario", ["base", "quota_plus_20", "quota_minus_20"])
def test_forecast_quantiles_are_ordered(client, scenario):
    steps = client.get(f"/api/forecast/A?scenario={scenario}").json()["steps"]
    assert len(steps) == 6
    for s in steps:
        assert s["q05"] <= s["q10"] <= s["q25"] <= s["q50"] <= s["q75"] <= s["q90"] <= s["q95"]


# this checks the supply direction so that more COEs never push the forecast up
def test_more_supply_does_not_raise_prices(client):
    low = client.get("/api/forecast/B?scenario=quota_minus_20").json()["steps"][-1]["q50"]
    high = client.get("/api/forecast/B?scenario=quota_plus_20").json()["steps"][-1]["q50"]
    assert high <= low * 1.02


# this checks the win curve only goes up so that a higher bid never looks worse
def test_bid_planner_probability_increases_with_bid(client):
    plan = client.get("/api/bid-planner/A").json()
    probs = [p["probability_pct"] for p in plan["curve"]]
    assert probs == sorted(probs)
    assert plan["q10"] <= plan["q25"] <= plan["expected_premium"] <= plan["q75"] <= plan["q90"]


# this checks a bad category so that users get a clean 404
def test_unknown_category_is_404(client):
    assert client.get("/api/forecast/Z").status_code == 404


# this checks the policy and model routes so that those pages have data
def test_policy_and_model_endpoints(client):
    assert len(client.get("/api/policy/events").json()) >= 5
    assert client.get("/api/model/metrics").json()["leaderboard"]
    assert client.get("/api/model/interpretability").json()["encoder"]
    assert client.get("/api/model/backtest/A?model=tft&horizon=1").json()["points"]


# this checks add, list and delete so that a target can go through its whole life
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


# this checks duplicates and bad values so that the watchlist stays clean
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


# this sends one question so that the tests below stay short
def _ask(client, question, **view):
    return client.post("/api/analyst/chat", json={"messages": [{"role": "user", "content": question}],
                                                  "view": view, "client_id": str(uuid.uuid4())})


# this checks the glossary terms the UI needs so that no popover is empty
def test_glossary_and_status(client):
    terms = {t["id"]: t for t in client.get("/api/glossary").json()}
    assert {"range-80", "significance", "box-tiao", "outlook", "uncertainty", "pqp", "smape", "attention"} <= set(terms)
    assert "not advice" in terms["outlook"]["simple"]
    assert client.get("/api/analyst/status").json()["mode"] in ("llm", "offline")


# this checks a navigate action comes back so that the panel can open pages
def test_analyst_navigation_and_provenance(client):
    res = _ask(client, "Show me Cat E", page="overview")
    assert res.status_code == 200
    body = res.json()
    nav = [a for a in body["actions"] if a["type"] == "navigate"]
    assert nav and nav[0]["params"]["page"] == "forecast" and nav[0]["params"]["category"] == "E"
    assert body["provenance"] and "bidding exercise" in body["provenance"]


# this checks alerts are drafts so that nothing saves until the user confirms
def test_analyst_alert_requests_need_confirmation(client):
    body = _ask(client, "Alert me when Cat A falls below $110k", page="alerts").json()
    drafts = [a for a in body["actions"] if a["type"] == "prepare_watch"]
    assert drafts and all(a["confirm"] for a in drafts)
    assert drafts[0]["params"]["target"] == 110000


# this checks the event order so that the browser can show the answer as it streams
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


# this checks the analyst follows the slider so that it talks about the value on screen
def test_analyst_sees_the_scenario_lab_slider(client):
    body = _ask(client, "Why is Cat A showing this outlook?", page="scenario", category="A", quota_pct=15).json()
    assert "+15% supply" in body["provenance"]
    body = _ask(client, "What if supply rises 15% for Cat B?", page="overview").json()
    action = [a for a in body["actions"] if a["type"] == "set_supply_scenario"][0]
    assert action["params"] == {"quota_pct": 15, "category": "B"} and "interpolated" in body["reply"]
    assert _ask(client, "hi", page="scenario", quota_pct=40).status_code == 422


# this checks the neutral wording so that the analyst never tells people to buy or wait
def test_analyst_does_not_tell_people_to_buy_or_wait(client):
    reply = _ask(client, "Should I buy now or wait?", page="forecast", category="A").json()["reply"]
    assert "doesn't tell you to buy or to wait" in reply and "Cat A shows" in reply


# this checks bad requests are refused so that the API cannot be fed junk
def test_analyst_validates_requests(client):
    assert client.post("/api/analyst/chat", json={"messages": []}).status_code == 422
    too_long = [{"role": "user", "content": "x" * 1001}]
    assert client.post("/api/analyst/chat", json={"messages": too_long}).status_code == 422
    bad_view = {"messages": [{"role": "user", "content": "hi"}], "view": {"page": "admin"}}
    assert client.post("/api/analyst/chat", json=bad_view).status_code == 422
