"""Structured context for the COE Compass analyst.

The browser only says *where* the viewer is (page, category, quota change, bid);
every number the analyst sees is re-read here from the database with the same
services the pages use, so the model is never fed scraped or client-supplied
figures.

Two parts:
  * ``app_data``      – shared by every viewer until the next model run
                        (all categories, policy effects, model accuracy);
  * ``current_view``  – what this viewer is looking at, plus their watchlist.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.engine import Connection

from ...config import settings
from ...labels import CATEGORIES, MODELS, SCENARIOS, exercise_label
from .. import quantiles as qt
from .. import repository as repo
from .. import scenarios as sc
from ..recommendation import Advice, advise, alert_outlook

PAGES = {
    "overview": "Overview",
    "forecast": "Forecast",
    "scenario": "Scenario Lab",
    "bid": "Bid planner",
    "plan": "My plan",
    "policy": "Policy Lab",
    "model": "Model performance",
    "alerts": "Watchlist",
    "learn": "Learn",
}
KIND = {"step": "Permanent shift", "pulse": "One-off shock", "temporary": "Temporary shift"}


@dataclass
class View:
    page: str = "overview"
    category: str | None = None
    scenario: str = "base"
    bid: float | None = None
    event: str | None = None
    quota_pct: int | None = None       # the Scenario Lab slider; None = use ``scenario``

    @property
    def pct(self) -> int:
        """Next quarter's quota change in percent, whichever way the page expressed it."""
        return sc.PCT_OF.get(self.scenario, 0) if self.quota_pct is None else self.quota_pct


@dataclass
class AnalystContext:
    """Everything the analyst may use, plus helpers for its data tools."""
    app_data: dict
    current_view: dict
    run: dict | None
    view: View
    alerts: list[dict] = field(default_factory=list)
    steps: dict = field(default_factory=dict)          # (category, scenario) -> forecast rows
    latest: dict = field(default_factory=dict)         # category -> latest exercise row
    recent: dict = field(default_factory=dict)         # category -> recent rows, oldest first

    @property
    def available(self) -> bool:
        return self.run is not None


def _r(v, digits=0):
    if v is None:
        return None
    return int(round(v)) if digits == 0 else round(float(v), digits)


def _range(row, lo, hi):
    return [_r(row[lo]), _r(row[hi])]


def load_steps(conn: Connection, ctx: AnalystContext, category: str, scenario: str) -> list[dict]:
    key = (category, scenario)
    if key not in ctx.steps and ctx.run:
        ctx.steps[key] = repo.forecast(conn, ctx.run["id"], category, scenario)
    return ctx.steps.get(key, [])


def steps_for_quota(conn: Connection, ctx: AnalystContext, category: str, pct: int) -> list[dict]:
    """Forecast rows for any quota change in the modelled range (interpolated between runs)."""
    if not ctx.run:
        return []
    return sc.steps_for(conn, ctx.run["id"], category, pct, load=lambda s: load_steps(conn, ctx, category, s))


def recommendation_for(ctx: AnalystContext, category: str, steps: list[dict]) -> Advice:
    latest = ctx.latest[category]
    return advise(CATEGORIES[category]["name"], latest["premium"], steps, ctx.recent[category],
                  settings.wait_threshold)


def outlook_dict(advice: Advice, summary: bool = True) -> dict:
    """The market outlook as the analyst sees it (plain keys, no internal codes)."""
    out = {
        "label": advice.label, "direction": advice.direction, "strength": advice.strength,
        "expected_change_pct": advice.expected_change_pct,
        "prob_higher_pct": advice.prob_higher_pct, "prob_lower_pct": advice.prob_lower_pct,
        "prob_meaningful_drop_pct": advice.prob_drop_pct,
        "model_uncertainty": f"{advice.uncertainty} (80% range is ±{advice.uncertainty_pct:.0f}% of today's premium)",
    }
    if summary:
        out["summary"] = advice.summary
    return out


def build(conn: Connection, view: View, client_id: str | None) -> AnalystContext:
    run = repo.latest_run(conn)
    ctx = AnalystContext(app_data={}, current_view={}, run=run, view=view)

    for row in repo.latest_exercises(conn, n=48):
        ctx.recent.setdefault(row["category"], []).append(row)
    for code, rows in ctx.recent.items():
        rows.reverse()                                   # oldest first
        ctx.latest[code] = rows[-1]
    if run:
        for row in repo.forecasts_all(conn, run["id"]):
            ctx.steps.setdefault((row["category"], "base"), []).append(row)

    data_through = None
    categories = []
    for code, meta in CATEGORIES.items():
        latest = ctx.latest.get(code)
        if not latest:
            continue
        data_through = data_through or exercise_label(latest["month"], latest["bidding_no"])
        prev = ctx.recent[code][-2] if len(ctx.recent[code]) > 1 else None
        entry = {
            "code": code, "name": meta["name"], "title": meta["title"], "definition": meta["description"],
            "latest_result": {
                "exercise": exercise_label(latest["month"], latest["bidding_no"]),
                "premium": latest["premium"], "quota": latest["quota"],
                "bids_per_coe": _r(latest["bids_received"] / max(latest["quota"], 1), 2),
                "change_vs_previous_pct": _r((latest["premium"] / prev["premium"] - 1) * 100, 1) if prev else None,
            },
        }
        steps = ctx.steps.get((code, "base"))
        if steps:
            advice = recommendation_for(ctx, code, steps)
            nxt, end = steps[0], steps[-1]
            values = qt.row_values(nxt)
            entry["forecast_as_announced"] = {
                "next_exercise": {"exercise": exercise_label(nxt["month"], nxt["bidding_no"]),
                                  "median": _r(nxt["q50"]), "range_50": _range(nxt, "q25", "q75"),
                                  "range_80": _range(nxt, "q10", "q90")},
                "end_of_quarter": {"exercise": advice.horizon_label, "median": _r(end["q50"]),
                                   "range_50": _range(end, "q25", "q75"), "range_80": _range(end, "q10", "q90")},
            }
            entry["outlook"] = outlook_dict(advice)
            entry["bid_suggestions_next_exercise"] = {
                f"{c}%_chance": _r(qt.quantile(values, c / 100)) for c in (50, 75, 90, 95)}
        categories.append(entry)

    events = []
    if run:
        effects = {}
        for e in repo.intervention_effects(conn, run["id"]):
            effects.setdefault(e["event_code"], []).append({
                "category": e["category"], "effect_pct": _r(e["pct_effect"], 1),
                "ci95_pct": [_r(e["pct_low"], 1), _r(e["pct_high"], 1)] if e["pct_low"] is not None else None,
                "p_value": _r(e["p_value"], 3),
                "significant": e["p_value"] is not None and e["p_value"] < 0.05,
            })
        for ev in repo.policy_events(conn):
            events.append({
                "code": ev["code"], "name": ev["name"], "effective": ev["effective_month"].strftime("%b %Y"),
                "kind": KIND.get(ev["kind"], ev["kind"]), "categories": list(ev["categories"]),
                "description": ev["description"], "estimated_effects": effects.get(ev["code"], []),
            })

    ctx.app_data = {
        "as_of": {
            "data_through": data_through,
            "model_run": run["id"] if run else None,
            "model_retrained": (run["finished_at"] or run["created_at"]).strftime("%d %b %Y") if run else None,
        },
        "outlook_rule": {
            "meaningful_drop_pct": round(settings.wait_threshold * 100),
            "horizon": "end of the next quota quarter (6 bidding exercises ahead)",
            "slight_direction_from_pct": 55, "clear_direction_from_pct": 65,
        },
        "supply_scenarios": [{"id": k, "label": v["label"], "description": v["description"]}
                             for k, v in SCENARIOS.items()],
        "supply_scenarios_note": "Any whole percentage from -20 to +20 can be looked up; points between the "
                                 "modelled scenarios are interpolated.",
        "categories": categories,
        "policy_events": events,
        "model_accuracy": _model_summary(conn),
    }
    if not run:
        ctx.app_data["notice"] = "No forecasts yet: the ML pipeline has not finished a run."

    if client_id:
        ctx.alerts = repo.list_alerts(conn, client_id)
    ctx.current_view = _current_view(conn, ctx)
    return ctx


def _model_summary(conn: Connection) -> dict | None:
    run = repo.latest_evaluated_run(conn)
    if not run:
        return None
    rows = repo.backtest_metrics(conn, run["id"])
    board = sorted((r for r in rows if r["category"] == "*" and r["horizon"] == 0), key=lambda r: r["pinball"])
    by_h = sorted((r for r in rows if r["category"] == "*" and r["horizon"] > 0 and r["model"] == "hybrid"),
                  key=lambda r: r["horizon"])
    backtest = (run["params"] or {}).get("backtest", {})
    return {
        "test_period_exercises": backtest.get("test_exercises"),
        "leaderboard_by_pinball_loss": [
            {"model": MODELS.get(r["model"], r["model"]), "pinball_usd": _r(r["pinball"]),
             "mape_pct": _r(r["mape"], 1), "coverage80_pct": _r(r["coverage80"], 1),
             "direction_accuracy_pct": _r(r["direction"], 1)} for r in board],
        "hybrid_by_horizon": [{"exercises_ahead": r["horizon"], "mape_pct": _r(r["mape"], 1),
                               "coverage80_pct": _r(r["coverage80"], 1)} for r in by_h],
    }


def _current_view(conn: Connection, ctx: AnalystContext) -> dict:
    v = ctx.view
    out: dict = {"page": PAGES.get(v.page, v.page)}
    if v.category:
        out["category"] = CATEGORIES[v.category]["name"]
    if v.page == "scenario":
        out["supply_scenario"] = sc.label(v.pct)
    if v.page == "policy" and v.event:
        out["highlighted_event"] = v.event

    cat = v.category
    if cat and ctx.run and cat in ctx.latest:
        pct = v.pct if v.page == "scenario" else 0
        steps = steps_for_quota(conn, ctx, cat, pct)
        if steps:
            advice = recommendation_for(ctx, cat, steps)
            out["focus"] = {
                "category": CATEGORIES[cat]["name"], "scenario": sc.label(pct),
                "forecast_next_six_exercises": [
                    {"exercise": exercise_label(s["month"], s["bidding_no"]), "quota_assumed": s["quota"],
                     "p10": _r(s["q10"]), "p25": _r(s["q25"]), "median": _r(s["q50"]), "p75": _r(s["q75"]),
                     "p90": _r(s["q90"])} for s in steps],
                "outlook": {
                    **outlook_dict(advice),
                    "lowest_expected": {"exercise": advice.cheapest_label, "median": _r(advice.cheapest_q50)},
                    "market_reasons": advice.reasons,
                },
            }
            if pct:
                base = recommendation_for(ctx, cat, load_steps(conn, ctx, cat, "base"))
                out["focus"]["vs_as_announced"] = {
                    "median_at_horizon_as_announced": _r(base.horizon_q50),
                    "difference": _r(advice.horizon_q50 - base.horizon_q50),
                    "interpolated": sc.scenario_id(pct) is None,
                }
        if v.page == "bid" and v.bid:
            base = load_steps(conn, ctx, cat, "base")
            if base:
                nxt = base[0]
                out["bid_planner"] = {
                    "exercise": exercise_label(nxt["month"], nxt["bidding_no"]),
                    "bid": _r(v.bid), "win_probability_pct": _r(qt.cdf(qt.row_values(nxt), v.bid) * 100, 1),
                    "expected_premium_median": _r(nxt["q50"]),
                }

    if ctx.alerts:
        out["watchlist"] = []
        for a in ctx.alerts:
            steps = load_steps(conn, ctx, a["category"], "base")
            latest = ctx.latest.get(a["category"], {}).get("premium", 0)
            o = alert_outlook(a["direction"], a["target"], latest, steps)
            out["watchlist"].append({
                "id": a["id"], "category": f"Cat {a['category']}", "direction": a["direction"], "target": a["target"],
                "note": a["label"], "status": o["status"], "chance_within_quarter_pct": o["probability_pct"],
                "most_likely_by": o["when"]})
    else:
        out["watchlist"] = []
    return out


def compact(app_data: dict, focus: str | None = None) -> dict:
    """A smaller app_data for providers with tight token limits (Groq's free tier allows
    8K tokens a minute, and a question that uses a tool costs two requests). Same
    numbers, less prose: outlook summaries are dropped (the model explains from
    the figures), categories other than the one in view are summarised in one line,
    the leaderboard keeps our model, the random walk and the best, and policy effects
    become rows."""
    out = {k: v for k, v in app_data.items()
           if k not in ("categories", "policy_events", "supply_scenarios", "model_accuracy")}
    out["supply_scenarios"] = {s["id"]: s["label"] for s in app_data.get("supply_scenarios", [])}
    out["categories"] = []
    for c in app_data.get("categories", []):
        rec = c.get("outlook")
        if focus and c["code"] != focus:
            brief = {"code": c["code"], "name": c["name"], "title": c["title"],
                     "latest_premium": c["latest_result"]["premium"]}
            if rec:
                brief.update(outlook=rec["label"], expected_change_pct=rec["expected_change_pct"],
                             prob_lower_pct=rec["prob_lower_pct"])
            out["categories"].append(brief)
            continue
        c = dict(c)
        if rec:
            c["outlook"] = {k: v for k, v in rec.items() if k != "summary"}
        out["categories"].append(c)
    if focus:
        out["categories_note"] = "Full detail for the category in view; the others are summarised."
    acc = app_data.get("model_accuracy")
    if acc:
        board = acc["leaderboard_by_pinball_loss"]
        keep = {board[0]["model"]} if board else set()
        keep |= {r["model"] for r in board if r["model"].startswith(("Hybrid", "Random walk"))}
        out["model_accuracy"] = {**acc, "models_compared": len(board),
                                 "leaderboard_by_pinball_loss": [r for r in board if r["model"] in keep]}
    out["policy_effect_columns"] = ["category", "effect_pct", "ci95_low_pct", "ci95_high_pct", "p_value", "significant"]
    out["policy_events"] = [
        {"code": ev["code"], "name": ev["name"], "effective": ev["effective"], "kind": ev["kind"],
         "effects": [[e["category"], e["effect_pct"], *(e["ci95_pct"] or [None, None]), e["p_value"], e["significant"]]
                     for e in ev["estimated_effects"]]}
        for ev in app_data.get("policy_events", [])]
    return out


def provenance(ctx: AnalystContext) -> str | None:
    """A short, deterministic 'based on' line shown under each answer."""
    as_of = ctx.app_data.get("as_of", {})
    if not as_of.get("data_through"):
        return None
    v = ctx.view
    subject = f"{CATEGORIES[v.category]['name']} forecast" if v.category else "COE Compass data"
    if v.page == "scenario" and v.category and v.pct:
        subject += f" ({sc.label(v.pct).lower()})"
    run = f" · model run #{as_of['model_run']}, retrained {as_of['model_retrained']}" if as_of.get("model_run") else ""
    return f"Based on {subject}, results through the {as_of['data_through']} bidding exercise{run}."
