"""Forecasts, what-if supply scenarios, the market outlook and the bid planner."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.engine import Connection

from ..config import settings
from ..labels import CATEGORIES, SCENARIOS
from ..db import get_connection
from ..schemas import BidPlan, Forecast, Recommendation, Scenario
from ..services import quantiles as qt
from ..services import repository as repo
from ..services import scenarios as sc
from ..services.recommendation import advise
from .common import require_category, require_run, require_scenario, with_label

router = APIRouter(tags=["forecast"])

QUOTA_PCT = Query(None, ge=sc.MIN_PCT, le=sc.MAX_PCT,
                  description="Next quarter's quota change in percent; overrides ``scenario``. Points between "
                              "the modelled scenarios are interpolated.")


def _load(conn: Connection, category: str, scenario: str, quota_pct: int | None = None):
    run = require_run(conn)
    pct = sc.PCT_OF[scenario] if quota_pct is None else quota_pct
    steps = sc.steps_for(conn, run["id"], category, pct)
    if not steps:
        raise HTTPException(status_code=404, detail="No forecast stored for this category / scenario.")
    history = repo.history(conn, category)
    return run, steps, history, pct


@router.get("/scenarios", response_model=list[Scenario])
def scenarios():
    return [{"id": key, "quota_pct": sc.PCT_OF[key], **meta} for key, meta in SCENARIOS.items()]


@router.get("/forecast/{category}", response_model=Forecast)
def forecast(category: str, scenario: str = "base", quota_pct: int | None = QUOTA_PCT,
             conn: Connection = Depends(get_connection)):
    """Quantile forecast (p5 ... p95) for the next quota quarter."""
    category, scenario = require_category(category), require_scenario(scenario)
    run, steps, history, pct = _load(conn, category, scenario, quota_pct)
    return {"category": category, "scenario": sc.scenario_id(pct) or "custom", "quota_pct": pct, "run": run,
            "origin": with_label(history[-1]), "steps": [with_label(s) for s in steps]}


@router.get("/recommendation/{category}", response_model=Recommendation)
def recommendation(category: str, scenario: str = "base", quota_pct: int | None = QUOTA_PCT,
                   threshold: float = Query(None, gt=0, lt=0.5,
                                            description="override the 8% meaningful-drop threshold"),
                   conn: Connection = Depends(get_connection)):
    """Market outlook: which way the forecast leans, how clearly, and the evidence behind it."""
    category, scenario = require_category(category), require_scenario(scenario)
    _, steps, history, pct = _load(conn, category, scenario, quota_pct)
    advice = advise(CATEGORIES[category]["name"], history[-1]["premium"], steps, history[-48:],
                    threshold or settings.wait_threshold)
    return {"category": category, "scenario": sc.scenario_id(pct) or "custom", "quota_pct": pct, **vars(advice)}


@router.get("/bid-planner/{category}", response_model=BidPlan)
def bid_planner(category: str, bid: float | None = Query(None, gt=0),
                conn: Connection = Depends(get_connection)):
    """Chance of winning the *next* bidding exercise with a given reserve price.

    In the COE auction every successful bidder pays the same premium (the lowest
    successful bid), so a bid wins whenever it is at least that premium:
    P(win) = P(premium <= bid), read from the forecast distribution.
    """
    category = require_category(category)
    _, steps, _, _ = _load(conn, category, "base")
    nxt = steps[0]
    values = qt.row_values(nxt)
    bid = bid or qt.quantile(values, 0.75)

    lo, hi = qt.quantile(values, 0.01), qt.quantile(values, 0.99)
    curve = [{"bid": lo + (hi - lo) * i / 59, "probability_pct": 0.0} for i in range(60)]
    for point in curve:
        point["probability_pct"] = round(qt.cdf(values, point["bid"]) * 100, 2)

    return {
        "category": category, "exercise": with_label(nxt), "bid": bid,
        "win_probability_pct": round(qt.cdf(values, bid) * 100, 1),
        "expected_premium": nxt["q50"],
        "q10": nxt["q10"], "q25": nxt["q25"], "q75": nxt["q75"], "q90": nxt["q90"],
        "suggestions": [{"confidence_pct": c, "bid": qt.quantile(values, c / 100)} for c in (50, 75, 90, 95)],
        "curve": curve,
    }
