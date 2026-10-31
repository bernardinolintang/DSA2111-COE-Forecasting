"""Helpers shared by the routers."""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.engine import Connection

from ..labels import CATEGORIES, SCENARIOS, exercise_label
from ..services import repository as repo


# this checks the category exists so that a typo gets a clear 404
def require_category(code: str) -> str:
    code = code.upper()
    if code not in CATEGORIES:
        raise HTTPException(status_code=404, detail=f"Unknown COE category '{code}'. Use A-E.")
    return code


# this checks the scenario exists so that a typo gets a clear 404
def require_scenario(scenario: str) -> str:
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=404, detail=f"Unknown scenario '{scenario}'.")
    return scenario


# this stops with a 503 if no run has finished so that pages can say forecasts are not ready
def require_run(conn: Connection) -> dict:
    run = repo.latest_run(conn)
    if run is None:
        raise HTTPException(status_code=503, detail="No forecasts yet: the ML pipeline has not finished a run.")
    return run


# this adds a readable exercise label so that the front end does not build it itself
def with_label(row: dict) -> dict:
    return {**row, "label": exercise_label(row["month"], row["bidding_no"])}
