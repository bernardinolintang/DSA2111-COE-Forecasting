"""Price alerts: the only data users write.

Alerts are keyed by an anonymous ``client_id`` (a UUID created in the browser),
so no login or personal data is needed. Each alert is scored against the
latest forecast: how likely is the premium to cross the target within the
forecast horizon?
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.engine import Connection

from ..config import settings
from ..db import get_connection
from ..schemas import Alert, AlertIn
from ..services import repository as repo
from ..services.recommendation import alert_outlook

router = APIRouter(prefix="/alerts", tags=["alerts"])


def _score(conn: Connection, alerts: list[dict]) -> list[dict]:
    run = repo.latest_run(conn)
    latest = {r["category"]: r["premium"] for r in repo.latest_exercises(conn, n=1)}
    steps_by_cat = {}
    scored = []
    for alert in alerts:
        cat = alert["category"]
        if run and cat not in steps_by_cat:
            steps_by_cat[cat] = repo.forecast(conn, run["id"], cat, "base")
        outlook = alert_outlook(alert["direction"], alert["target"], latest.get(cat, 0), steps_by_cat.get(cat, []))
        scored.append({**alert, "latest_premium": latest.get(cat, 0), **outlook})
    return scored


@router.get("", response_model=list[Alert])
def list_alerts(client_id: UUID, conn: Connection = Depends(get_connection)):
    return _score(conn, repo.list_alerts(conn, str(client_id)))


@router.post("", response_model=Alert, status_code=status.HTTP_201_CREATED)
def create_alert(alert: AlertIn, conn: Connection = Depends(get_connection)):
    if repo.count_alerts(conn, str(alert.client_id)) >= settings.max_alerts_per_client:
        raise HTTPException(status_code=429, detail="Alert limit reached. Delete an alert first.")
    row = repo.create_alert(conn, str(alert.client_id), alert.category, alert.direction, alert.target, alert.label)
    return _score(conn, [row])[0]


@router.delete("/{alert_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_alert(alert_id: int, client_id: UUID, conn: Connection = Depends(get_connection)):
    if not repo.delete_alert(conn, alert_id, str(client_id)):
        raise HTTPException(status_code=404, detail="Alert not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
