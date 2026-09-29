"""Policy Lab: structural shocks and their Box-Tiao estimated effects."""

from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Connection

from ..db import get_connection
from ..schemas import PolicyEvent
from ..services import repository as repo

router = APIRouter(tags=["policy"])


@router.get("/policy/events", response_model=list[PolicyEvent])
def policy_events(conn: Connection = Depends(get_connection)):
    run = repo.latest_run(conn)
    effects = defaultdict(list)
    if run:
        for e in repo.intervention_effects(conn, run["id"]):
            effects[e["event_code"]].append({
                "category": e["category"], "pct_effect": e["pct_effect"], "pct_low": e["pct_low"],
                "pct_high": e["pct_high"], "p_value": e["p_value"],
                "significant": e["p_value"] is not None and e["p_value"] < 0.05,
            })
    return [{**event, "categories": list(event["categories"]), "effects": effects.get(event["code"], [])}
            for event in repo.policy_events(conn)]
