"""Unit tests for the COE Analyst (no database, no network).

The repository layer is replaced with small fixtures so the context builder,
the action whitelist, basic mode and the Claude tool loop can all be tested
offline. The loop is driven by a fake client that replays scripted responses.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest

from app.services import repository as repo
from app.services.analyst import actions, context, llm, offline
from app.services.analyst import tools as data_tools

# ---------------------------------------------------------------------------
# Fixtures: a tiny fake database
# ---------------------------------------------------------------------------
LEVELS = [0.8, 0.85, 0.92, 1.0, 1.08, 1.15, 1.2]
COLS = ["q05", "q10", "q25", "q50", "q75", "q90", "q95"]
PREMIUM = {"A": 131_890, "B": 133_000}


def _months(n):
    out, y, m = [], 2024, 10
    for _ in range(n):
        out.append(date(y, m, 1))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def _steps(cat, scenario="base"):
    mult = {"base": 1.0, "quota_plus_20": 0.95, "quota_minus_20": 1.05}.get(scenario, 1.0)
    rows = []
    for i in range(1, 7):
        median = PREMIUM[cat] * (1 + 0.002 * i) * mult
        rows.append({"category": cat, "step": i, "month": date(2026, 10 + (i - 1) // 2, 1),
                     "bidding_no": 1 + (i - 1) % 2, "quota": 1193,
                     **{c: median * f for c, f in zip(COLS, LEVELS)}})
    return rows


@pytest.fixture
def fake_db(monkeypatch):
    run = {"id": 7, "created_at": datetime(2026, 9, 29, tzinfo=timezone.utc),
           "finished_at": datetime(2026, 9, 29, tzinfo=timezone.utc), "params": {"backtest": {"test_exercises": 72}}}
    alerts = [{"id": 11, "category": "A", "direction": "below", "target": 120_000, "label": "My car",
               "created_at": datetime(2026, 9, 1, tzinfo=timezone.utc)}]

    def latest_exercises(conn, n=25):
        rows = []
        for cat, p in PREMIUM.items():
            for k, month in enumerate(reversed(_months(24))):          # newest first
                rows.append({"category": cat, "month": month, "bidding_no": 2, "premium": p - 500 * k,
                             "quota": 1193, "bids_received": 1500, "bids_success": 1190})
        return rows

    patches = {
        "latest_run": lambda conn: run,
        "latest_evaluated_run": lambda conn: run,
        "latest_exercises": latest_exercises,
        "forecasts_all": lambda conn, run_id, scenario="base": _steps("A") + _steps("B"),
        "forecast": lambda conn, run_id, cat, scenario: _steps(cat, scenario) if cat in PREMIUM else [],
        "intervention_effects": lambda conn, run_id: [
            {"event_code": "loans", "category": "B", "pct_effect": -38.2, "pct_low": -60.0, "pct_high": 5.0,
             "p_value": 0.12},
            {"event_code": "inject", "category": "B", "pct_effect": -2.4, "pct_low": -9.0, "pct_high": 4.0,
             "p_value": 0.5},
            {"event_code": "inject", "category": "A", "pct_effect": -7.8, "pct_low": -12.0, "pct_high": -3.0,
             "p_value": 0.01}],
        "policy_events": lambda conn: [
            {"code": "loans", "name": "MAS car-loan curbs", "effective_month": date(2013, 2, 1), "kind": "step",
             "categories": "AB", "description": "Loan caps."},
            {"code": "inject", "name": "20,000 COE injection", "effective_month": date(2025, 2, 1), "kind": "step",
             "categories": "AB", "description": "More COEs."}],
        "backtest_metrics": lambda conn, run_id: [
            {"model": "hybrid", "category": "*", "horizon": 0, "pinball": 1928, "mape": 6.8, "coverage80": 87.9,
             "direction": 59.6},
            {"model": "naive", "category": "*", "horizon": 0, "pinball": 1937, "mape": 6.8, "coverage80": 86.7,
             "direction": None},
            {"model": "hybrid", "category": "*", "horizon": 1, "pinball": 1000, "mape": 4.1, "coverage80": 88.0,
             "direction": 60.0}],
        "list_alerts": lambda conn, cid: alerts,
        "history": lambda conn, cat, since=None: [
            {"month": m, "bidding_no": 1, "premium": 100_000 + 1000 * i, "quota": 1000, "bids_received": 1500,
             "bids_success": 1000} for i, m in enumerate(_months(12))],
    }
    for name, fn in patches.items():
        monkeypatch.setattr(repo, name, fn)
    return run


LABELS = ("Downward pressure", "Slight downward pressure", "No clear direction", "Slight upward pressure",
          "Upward pressure")


def _ctx(page="overview", category=None, scenario="base", bid=None, client_id="c1", quota_pct=None):
    view = context.View(page=page, category=category, scenario=scenario, bid=bid, quota_pct=quota_pct)
    return context.build(None, view, client_id)


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------
def test_context_contains_every_category_with_real_numbers(fake_db):
    ctx = _ctx()
    cats = {c["code"]: c for c in ctx.app_data["categories"]}
    assert set(cats) == {"A", "B"}
    assert cats["A"]["latest_result"]["premium"] == 131_890
    assert cats["A"]["outlook"]["label"] in LABELS
    assert "action" not in cats["A"]["outlook"] and "recommendation" not in cats["A"]
    assert cats["A"]["forecast_as_announced"]["next_exercise"]["exercise"] == "Oct 2026 · 1st"
    assert ctx.app_data["as_of"]["model_run"] == 7
    assert ctx.app_data["policy_events"][0]["estimated_effects"][0]["significant"] is False


def test_current_view_reflects_page_category_scenario_and_bid(fake_db):
    ctx = _ctx(page="scenario", category="A", scenario="quota_plus_20")
    focus = ctx.current_view["focus"]
    assert ctx.current_view["page"] == "Scenario Lab" and ctx.current_view["category"] == "Cat A"
    assert ctx.current_view["supply_scenario"] == focus["scenario"] == "+20% supply"
    assert focus["forecast_next_six_exercises"][0]["median"] == round(_steps("A", "quota_plus_20")[0]["q50"])
    assert focus["vs_as_announced"]["interpolated"] is False and focus["vs_as_announced"]["difference"] < 0

    # the slider: +15% is half-way between the +10% and +20% runs, and says it is interpolated
    ctx = _ctx(page="scenario", category="A", quota_pct=15)
    focus = ctx.current_view["focus"]
    half = (_steps("A", "quota_plus_10")[0]["q50"] + _steps("A", "quota_plus_20")[0]["q50"]) / 2
    assert focus["scenario"] == "+15% supply" and focus["vs_as_announced"]["interpolated"] is True
    assert focus["forecast_next_six_exercises"][0]["median"] == round(half)
    assert "+15% supply" in context.provenance(ctx)

    # the Forecast page always shows the forecast as announced
    assert _ctx(page="forecast", category="A", scenario="quota_plus_20").current_view["focus"]["scenario"] == "As announced"

    bid = _ctx(page="bid", category="B", bid=140_000).current_view["bid_planner"]
    assert bid["bid"] == 140_000 and 50 < bid["win_probability_pct"] < 100


def test_watchlist_is_in_the_view_and_provenance_names_the_data(fake_db):
    ctx = _ctx(page="forecast", category="A")
    assert ctx.current_view["watchlist"][0]["target"] == 120_000
    line = context.provenance(ctx)
    assert "Cat A forecast" in line and "Sep 2026 · 2nd" in line and "#7" in line


# ---------------------------------------------------------------------------
# Action whitelist
# ---------------------------------------------------------------------------
def test_navigation_actions_are_validated_and_normalised():
    a = actions.validate("navigate", {"page": "bid", "category": "a", "bid": 125000.4})
    assert a.as_dict() == {"type": "navigate", "params": {"page": "bid", "category": "A", "bid": 125000},
                           "confirm": False, "summary": "Open Bid planner for Cat A"}
    with pytest.raises(actions.ActionError):
        actions.validate("navigate", {"page": "admin"})
    with pytest.raises(actions.ActionError):
        actions.validate("navigate", {"page": "forecast", "category": "Z"})
    with pytest.raises(actions.ActionError):
        actions.validate("delete_everything", {})
    for page in ("scenario", "plan", "learn"):
        assert actions.validate("navigate", {"page": page}).params["page"] == page


def test_supply_scenarios_open_the_scenario_lab():
    a = actions.validate("navigate", {"page": "forecast", "category": "B", "scenario": "quota_plus_10"})
    assert a.params == {"page": "scenario", "category": "B", "scenario": "quota_plus_10"}
    assert a.summary == "Open Scenario Lab for Cat B"
    a = actions.validate("set_supply_scenario", {"scenario": "quota_minus_10"})
    assert a.params == {"quota_pct": -10, "scenario": "quota_minus_10"} and a.summary == "Supply scenario: −10% supply"
    a = actions.validate("set_supply_scenario", {"quota_pct": 7, "category": "c"})
    assert a.params == {"quota_pct": 7, "category": "C"} and a.summary == "Supply scenario: +7% supply"
    for bad in ({"quota_pct": 30}, {"quota_pct": "lots"}, {"scenario": "quota_plus_99"}, {}):
        with pytest.raises(actions.ActionError):
            actions.validate("set_supply_scenario", bad)


def test_persistent_actions_require_confirmation():
    watch = actions.validate("prepare_watch", {"category": "A", "direction": "below", "target": 110_000})
    assert watch.confirm is True and watch.summary == "Watch Cat A below $110,000"
    with pytest.raises(actions.ActionError):
        actions.validate("prepare_watch", {"category": "A", "direction": "below", "target": -5})
    mine = {11: {"category": "A", "direction": "below", "target": 120_000}}
    remove = actions.validate("prepare_remove_watch", {"id": 11}, mine)
    assert remove.confirm is True
    with pytest.raises(actions.ActionError):
        actions.validate("prepare_remove_watch", {"id": 99}, mine)       # not this user's


# ---------------------------------------------------------------------------
# Basic (offline) mode
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("question, page, category", [
    ("Show me Cat E.", "forecast", "E"),
    ("Take me to the bid planner for Cat A", "bid", "A"),
    ("open the model page", "model", None),
    ("go to my watchlist", "alerts", None),
    ("take me to the scenario lab", "scenario", "A"),
    ("open my plan", "plan", None),
    ("show me the data sources", "learn", None),
])
def test_offline_navigation(fake_db, question, page, category):
    reply, acts = offline.answer(question, _ctx(), None)
    assert acts and acts[0].type == "navigate" and acts[0].params["page"] == page
    assert acts[0].params.get("category") == category


def test_offline_alert_is_only_a_draft(fake_db):
    reply, acts = offline.answer("Alert me when Cat A falls below $110k", _ctx(), None)
    assert acts[0].type == "prepare_watch" and acts[0].confirm
    assert acts[0].params == {"category": "A", "direction": "below", "target": 110_000, "note": None}
    assert "Confirm" in reply and "created" not in reply.lower()


def test_offline_bid_for_probability_uses_the_forecast(fake_db):
    ctx = _ctx(page="bid", category="A")
    reply, acts = offline.answer("How much should I bid if I want a 90% chance?", ctx, None)
    expected = data_tools.run(None, ctx, "bid_for_probability", {"category": "A", "probability_pct": 90})["bid"]
    assert f"${expected:,}" in reply
    assert acts[0].type == "set_bid_amount" and acts[0].params["amount"] == expected


def test_offline_explains_recommendation_and_terms(fake_db):
    reply, _ = offline.answer("Why is Cat A showing no clear direction?", _ctx(), None)
    assert "Cat A shows" in reply and "8%" in reply and "55%" in reply
    assert "buy now" not in reply.lower()
    reply, _ = offline.answer("Should I buy now or wait?", _ctx(page="forecast", category="A"), None)
    assert reply.startswith("COE Compass doesn't tell you to buy or to wait") and "Cat A shows" in reply
    reply, _ = offline.answer("Why do all categories say the same thing?", _ctx(), None)
    assert "- Cat A:" in reply and "- Cat B:" in reply
    reply, _ = offline.answer("What does n.s. mean in Policy Lab?", _ctx(page="policy"), None)
    assert "not statistically significant" in reply
    reply, _ = offline.answer("What does the 80% range mean?", _ctx(), None)
    assert reply.startswith("80% range")


def test_offline_biggest_policy_effect_and_scenarios(fake_db):
    reply, acts = offline.answer("What changed Cat B prices the most historically?", _ctx(), None)
    assert "MAS car-loan curbs" in reply and "not statistically significant" in reply
    assert acts[0].params == {"page": "policy", "category": "B", "event": "loans"}
    reply, acts = offline.answer("What if supply rises 20% for Cat A?", _ctx(), None)
    assert acts[0].type == "set_supply_scenario" and acts[0].params["scenario"] == "quota_plus_20"
    assert "the outlook is" in reply and "interpolated" not in reply
    reply, acts = offline.answer("What if supply rises 15% for Cat A?", _ctx(), None)
    assert acts[0].params == {"quota_pct": 15, "category": "A"} and "interpolated" in reply
    assert offline.detect_quota_pct("cut the quota by 12%") == -12
    assert offline.detect_quota_pct("supply up 45%") is None                     # outside the modelled range


def test_offline_admits_what_it_cannot_do(fake_db):
    reply, acts = offline.answer("Write me a poem about durians", _ctx(), None)
    assert "basic mode" in reply and not acts


# ---------------------------------------------------------------------------
# Claude loop with a scripted fake client
# ---------------------------------------------------------------------------
def _text(t):
    return SimpleNamespace(type="text", text=t)


def _tool(name, args, tid="tu_1"):
    return SimpleNamespace(type="tool_use", name=name, input=args, id=tid)


class FakeClient:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(json.loads(json.dumps(kwargs, default=lambda o: getattr(o, "__dict__", str(o)))))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _resp(stop, *blocks):
    return SimpleNamespace(stop_reason=stop, content=list(blocks))


def _run(client, question="q", alerts=None, tool=None):
    return llm.answer([], question, {"categories": []}, {"page": "Forecast"},
                      tool or (lambda name, params: {"ok": True, "name": name}), alerts or {}, client=client)


def test_llm_request_shape_caching_and_fallback():
    client = FakeClient(_resp("end_turn", _text("Hello")))
    reply, acts, used = _run(client)
    call = client.calls[0]
    assert reply == "Hello" and acts == [] and used == []
    assert call["model"] == "claude-opus-5-5" and call["fallbacks"] == "default"
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert all(b["cache_control"] == {"type": "ephemeral"} for b in call["system"])
    assert "<app_data>" in call["system"][1]["text"]
    assert "<current_view>" in call["messages"][-1]["content"][0]["text"]
    assert {t["name"] for t in call["tools"]} >= {"navigate", "prepare_watch", "bid_win_probability"}


def test_llm_runs_data_tools_and_returns_their_numbers():
    seen = []
    client = FakeClient(
        _resp("tool_use", _tool("bid_for_probability", {"category": "A", "probability_pct": 90})),
        _resp("end_turn", _text("Bid about $141,860.")),
    )
    reply, acts, used = _run(client, tool=lambda n, p: seen.append((n, p)) or {"bid": 141860})
    assert reply == "Bid about $141,860." and used == ["bid_for_probability"]
    assert seen == [("bid_for_probability", {"category": "A", "probability_pct": 90})]
    result = client.calls[1]["messages"][-1]["content"][0]
    assert result["type"] == "tool_result" and json.loads(result["content"]) == {"bid": 141860}


def test_llm_ui_action_with_text_needs_no_second_call():
    client = FakeClient(_resp("tool_use", _text("Opening Cat E's forecast."),
                              _tool("navigate", {"page": "forecast", "category": "E"})))
    reply, acts, _ = _run(client)
    assert len(client.calls) == 1
    assert reply == "Opening Cat E's forecast." and acts[0].params == {"page": "forecast", "category": "E"}


def test_llm_invalid_action_is_rejected_and_reported_back():
    client = FakeClient(
        _resp("tool_use", _tool("navigate", {"page": "forecast", "category": "Z"})),
        _resp("end_turn", _text("Cat Z doesn't exist; categories are A-E.")),
    )
    reply, acts, _ = _run(client)
    assert acts == []
    result = client.calls[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "Unknown category" in result["content"]


def test_llm_watchlist_changes_are_drafts_needing_confirmation():
    client = FakeClient(
        _resp("tool_use", _tool("prepare_watch", {"category": "A", "direction": "below", "target": 110000})),
        _resp("end_turn", _text("Press Confirm to add Cat A below $110,000.")),
    )
    reply, acts, _ = _run(client)
    assert acts[0].type == "prepare_watch" and acts[0].confirm is True
    assert "Confirm" in client.calls[1]["messages"][-1]["content"][0]["content"]


def test_llm_refusal_and_api_errors_raise_unavailable():
    with pytest.raises(llm.AnalystUnavailable):
        _run(FakeClient(_resp("refusal")))
    import anthropic

    timeout = anthropic.APITimeoutError.__new__(anthropic.APITimeoutError)
    with pytest.raises(llm.AnalystUnavailable, match="too long"):
        _run(FakeClient(timeout))


def test_llm_repeated_actions_are_deduplicated():
    nav = {"page": "bid", "category": "A"}
    client = FakeClient(
        _resp("tool_use", _tool("navigate", nav, "t1"), _tool("history_summary", {"category": "A", "years": 1}, "t2")),
        _resp("tool_use", _text("Here you go."), _tool("navigate", nav, "t3")),
    )
    reply, acts, _ = _run(client)
    assert [a.type for a in acts] == ["navigate"]


# ---------------------------------------------------------------------------
# Groq: streamed chat completions with tool calls, replayed by a fake client
# ---------------------------------------------------------------------------
from app import config as app_config
from app.services.analyst import groq_llm


def _chunk(content=None, calls=None):
    delta = SimpleNamespace(content=content, tool_calls=[
        SimpleNamespace(index=i, id=cid, function=SimpleNamespace(name=name, arguments=args))
        for i, cid, name, args in (calls or [])])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=None)])


class FakeGroq:
    def __init__(self, *turns):
        self.turns = list(turns)
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(json.loads(json.dumps(kwargs, default=str)))
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return iter(turn)


def _groq(client, tool=None, alerts=None):
    return list(groq_llm.stream([], "q", {"categories": [], "policy_events": [], "supply_scenarios": []},
                                {"page": "Forecast"}, tool or (lambda n, p: {"ok": n}), alerts or {}, client=client))


def test_groq_streams_text_and_sends_a_compact_request():
    client = FakeGroq([_chunk("Cat A shows "), _chunk("no clear direction.")])
    events = _groq(client)
    assert events == [("delta", "Cat A shows "), ("delta", "no clear direction.")]
    call = client.calls[0]
    assert call["stream"] is True and call["tool_choice"] == "auto"
    names = {t["function"]["name"] for t in call["tools"]}
    assert {"navigate", "prepare_watch", "bid_for_probability", "explain_term"} <= names
    assert "APP DATA" in call["messages"][0]["content"] and "policy_effect_columns" in call["messages"][0]["content"]
    assert call["messages"][-1]["content"].startswith("CURRENT VIEW")


def test_groq_runs_data_tools_with_arguments_split_across_chunks():
    seen = []
    client = FakeGroq(
        [_chunk(calls=[(0, "c1", "bid_for_probability", '{"category": "A", ')]),
         _chunk(calls=[(0, None, None, '"probability_pct": 90}')])],
        [_chunk("Bid about $141,860.")],
    )
    events = _groq(client, tool=lambda n, p: seen.append((n, p)) or {"bid": 141860})
    assert seen == [("bid_for_probability", {"category": "A", "probability_pct": 90})]
    assert events[0][0] == "status" and events[-1] == ("delta", "Bid about $141,860.")
    tool_msg = client.calls[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"] == "c1" and "141860" in tool_msg["content"]
    assistant = client.calls[1]["messages"][-2]
    assert assistant["tool_calls"][0]["function"]["name"] == "bid_for_probability"
    # the follow-up request drops APP DATA so two requests fit Groq's free token budget
    assert "APP DATA\n{" in client.calls[0]["messages"][0]["content"]
    assert "omitted here to save tokens" in client.calls[1]["messages"][0]["content"]


def test_groq_ui_actions_are_validated_and_need_no_second_call():
    client = FakeGroq([_chunk("Opening Cat E's forecast."),
                       _chunk(calls=[(0, "c1", "navigate", '{"page": "forecast", "category": "E"}')])])
    events = _groq(client)
    assert len(client.calls) == 1
    action = [e[1] for e in events if e[0] == "action"][0]
    assert action.params == {"page": "forecast", "category": "E"} and not action.confirm


def test_groq_bad_arguments_are_reported_back_not_executed():
    client = FakeGroq([_chunk(calls=[(0, "c1", "prepare_watch", '{"category": "Z", "direction": "below", "target": 1}'),
                                     (1, "c2", "navigate", "not json")])],
                      [_chunk("Sorry, categories are A-E.")])
    events = _groq(client)
    assert not [e for e in events if e[0] == "action"]
    results = [m["content"] for m in client.calls[1]["messages"] if m["role"] == "tool"]
    assert results[0].startswith("Error: Unknown category") and results[1].startswith("Error:")


def test_groq_rate_limit_raises_unavailable():
    import groq

    with pytest.raises(llm.AnalystUnavailable, match="rate limit"):
        _groq(FakeGroq(groq.RateLimitError.__new__(groq.RateLimitError)))


@pytest.mark.parametrize("env, provider", [
    ({}, "offline"),
    ({"GROQ_API_KEY": "gsk_x"}, "groq"),
    ({"ANTHROPIC_API_KEY": "sk-ant-x"}, "anthropic"),
    ({"GROQ_API_KEY": "gsk_x", "ANTHROPIC_API_KEY": "sk-ant-x"}, "groq"),
    ({"GROQ_API_KEY": "gsk_x", "ANTHROPIC_API_KEY": "sk-ant-x", "ANALYST_PROVIDER": "anthropic"}, "anthropic"),
    ({"ANALYST_PROVIDER": "groq"}, "offline"),                      # asked for Groq but no key
    ({"GROQ_API_KEY": "gsk_x", "ANALYST_ENABLED": "false"}, "offline"),
])
def test_provider_is_picked_from_the_key_in_env(monkeypatch, env, provider):
    for k in ("GROQ_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANALYST_PROVIDER", "ANALYST_ENABLED"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert app_config.analyst_provider() == provider


def test_compact_app_data_keeps_every_number(fake_db):
    full = _ctx().app_data
    small = context.compact(full)
    assert len(json.dumps(small)) < len(json.dumps(full))
    assert small["categories"][0]["latest_result"] == full["categories"][0]["latest_result"]
    loans = next(e for e in small["policy_events"] if e["code"] == "loans")
    assert loans["effects"] == [["B", -38.2, -60.0, 5.0, 0.12, False]]


def test_compact_focuses_on_the_category_in_view(fake_db):
    full = _ctx().app_data
    small = context.compact(full, focus="B")
    a, b = small["categories"]
    assert b == {**full["categories"][1], "outlook": {k: v for k, v in full["categories"][1]["outlook"].items()
                                                      if k != "summary"}}
    assert set(a) == {"code", "name", "title", "latest_premium", "outlook", "expected_change_pct", "prob_lower_pct"}
    assert a["latest_premium"] == 131_890
    assert [r["model"] for r in small["model_accuracy"]["leaderboard_by_pinball_loss"]] == [
        "Hybrid: TFT + Box-Tiao ARIMAX (ours)", "Random walk"]
    assert small["model_accuracy"]["models_compared"] == 2
