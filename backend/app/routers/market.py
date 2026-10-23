"""Market data: categories, dashboard summary, price history and macro context."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.engine import Connection

from ..config import settings
from ..db import get_connection
from ..labels import CATEGORIES
from ..schemas import Category, History, Summary
from ..services import repository as repo
from ..services.recommendation import advise, signal
from .common import require_category, with_label

router = APIRouter(tags=["market"])


@router.get("/categories", response_model=list[Category])
def categories():
    return [{"code": code, **meta} for code, meta in CATEGORIES.items()]


@router.get("/summary", response_model=Summary)
def summary(conn: Connection = Depends(get_connection)):
    """Everything the home page and the market status bar need in a single request."""
    run = repo.latest_run(conn)
    recent = defaultdict(list)
    for row in repo.latest_exercises(conn, n=25):
        recent[row["category"]].append(row)            # newest first

    forecasts = defaultdict(list)
    if run:
        for row in repo.forecasts_all(conn, run["id"]):
            forecasts[row["category"]].append(row)

    cards, data_through, next_exercise = [], None, None
    for code, meta in CATEGORIES.items():
        rows = recent.get(code)
        if not rows:
            continue
        latest, previous = rows[0], rows[1] if len(rows) > 1 else None
        data_through = data_through or with_label(latest)
        year_ago = repo.premium_year_ago(conn, code, latest["month"], latest["bidding_no"])
        card = {
            "code": code, **meta,
            "latest": with_label(latest),
            "previous_premium": previous["premium"] if previous else None,
            "change": latest["premium"] - previous["premium"] if previous else None,
            "change_pct": (latest["premium"] / previous["premium"] - 1) * 100 if previous else None,
            "year_ago_pct": (latest["premium"] / year_ago - 1) * 100 if year_ago else None,
            "sparkline": [r["premium"] for r in reversed(rows)],
            "next_label": None, "next_q10": None, "next_q50": None, "next_q90": None,
            "horizon_q10": None, "horizon_q50": None, "horizon_q90": None,
            "horizon_label": None, "signal": None,
        }
        steps = forecasts.get(code)
        if steps:
            advice = advise(meta["name"], latest["premium"], steps, list(reversed(rows)), settings.wait_threshold)
            next_exercise = next_exercise or with_label(steps[0])
            card.update(
                next_label=advice.next_label, next_q10=advice.next_q10, next_q50=advice.next_q50,
                next_q90=advice.next_q90, horizon_q10=advice.horizon_q10, horizon_q50=advice.horizon_q50,
                horizon_q90=advice.horizon_q90, horizon_label=advice.horizon_label, signal=signal(advice),
            )
        cards.append(card)
    return {"run": run, "data_through": data_through, "next_exercise": next_exercise, "categories": cards}


@router.get("/history/{category}", response_model=History)
def history(category: str, years: int = Query(5, ge=0, le=30, description="0 = full history"),
            conn: Connection = Depends(get_connection)):
    category = require_category(category)
    since = None
    if years:
        today = date.today()
        since = date(today.year - years, today.month, 1)
    return {"category": category, "points": [with_label(r) for r in repo.history(conn, category, since)]}


@router.get("/macro")
def macro(years: int = Query(10, ge=1, le=30), conn: Connection = Depends(get_connection)):
    """Monthly CPI, 3-month SORA and real GDP (quarterly) for the context charts."""
    today = date.today()
    series = defaultdict(list)
    for row in repo.macro(conn, date(today.year - years - 1, 1, 1)):
        series[row["indicator"]].append({"month": row["month"], "value": row["value"]})
    cpi = series.get("cpi_all_items", [])
    by_month = {p["month"]: p["value"] for p in cpi}
    inflation = [
        {"month": p["month"], "value": round((p["value"] / by_month[prev] - 1) * 100, 2)}
        for p in cpi
        if (prev := date(p["month"].year - 1, p["month"].month, 1)) in by_month
    ]
    return {"inflation_yoy": inflation, "sora_3m": series.get("sora_3m", []), "gdp_real": series.get("gdp_real", [])}
