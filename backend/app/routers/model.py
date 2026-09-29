"""Model transparency: backtest accuracy, predicted-vs-actual and TFT interpretability."""

from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.engine import Connection

from ..db import get_connection
from ..labels import MODELS, VARIABLES
from ..schemas import Backtest, Interpretability, Metrics
from ..services import repository as repo
from .common import require_category, require_run, with_label

router = APIRouter(prefix="/model", tags=["model"])


def _evaluated_run(conn: Connection) -> dict:
    run = repo.latest_evaluated_run(conn)
    if run is None:
        raise HTTPException(status_code=503, detail="No evaluated model yet: run the full ML pipeline once.")
    return run


@router.get("/metrics", response_model=Metrics)
def metrics(conn: Connection = Depends(get_connection)):
    """Backtest leaderboard from the latest run that was fully evaluated."""
    run = _evaluated_run(conn)
    rows = [{**r, "label": MODELS.get(r["model"], r["model"])} for r in repo.backtest_metrics(conn, run["id"])]
    backtest = run["params"].get("backtest", {})
    return {
        "run": run,
        "test_period": {"exercises": backtest.get("test_exercises"), "origin_stride": backtest.get("origin_stride")},
        "leaderboard": sorted((r for r in rows if r["category"] == "*" and r["horizon"] == 0),
                              key=lambda r: r["pinball"]),
        "by_horizon": sorted((r for r in rows if r["category"] == "*" and r["horizon"] > 0),
                             key=lambda r: (r["model"], r["horizon"])),
        "by_category": sorted((r for r in rows if r["category"] != "*" and r["horizon"] == 0),
                              key=lambda r: (r["category"], r["pinball"])),
    }


@router.get("/backtest/{category}", response_model=Backtest)
def backtest(category: str, model: str = "hybrid", horizon: int = Query(1, ge=1, le=12),
             conn: Connection = Depends(get_connection)):
    """Out-of-sample predictions vs actual premiums for one model and horizon."""
    category = require_category(category)
    if model not in MODELS:
        raise HTTPException(status_code=404, detail=f"Unknown model '{model}'.")
    run = _evaluated_run(conn)
    points = [with_label(p) for p in repo.backtest_predictions(conn, run["id"], category, model, horizon)]
    return {"category": category, "model": model, "horizon": horizon, "points": points}


@router.get("/interpretability", response_model=Interpretability)
def interpretability(conn: Connection = Depends(get_connection)):
    """TFT variable-selection weights (past and future inputs) and attention by lag."""
    run = require_run(conn)
    groups = defaultdict(list)
    for r in repo.variable_importance(conn, run["id"]):
        groups[r["component"]].append({"variable": r["variable"], "label": VARIABLES.get(r["variable"], r["variable"]),
                                        "importance": r["importance"]})
    attention = defaultdict(list)
    for r in repo.attention(conn, run["id"]):
        attention[r["category"]].append({"lag": r["lag"], "weight": r["weight"]})
    return {"encoder": groups["encoder"], "decoder": groups["decoder"], "attention": attention}


@router.get("/runs")
def runs(conn: Connection = Depends(get_connection)):
    """Recent pipeline executions (the ML job runs after every bidding exercise)."""
    return repo.recent_runs(conn)
