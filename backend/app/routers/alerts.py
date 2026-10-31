"""Price watchlist ("alerts"): the only data users write.

Alerts are keyed by an anonymous ``client_id`` (a UUID created in the browser),
so no login or personal data is needed. Each alert is scored against the
latest forecast: how likely is the premium to cross the target within the
forecast horizon?

Nothing is pushed to the user: there is no email, SMS or push channel. The
web app shows the scored list, and flags status changes the next time the
viewer opens the site, which is why the UI calls this a watchlist.
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


# this adds the latest premium and forecast odds to each alert so that the list always reflects the
# newest run
def _score(conn: Connection, alerts: list[dict]) -> list[dict]:
    run = repo.latest_run(conn)
    latest = {r["category"]: r["premium"] for r in repo.latest_exercises(conn, n=1)}
    steps_by_cat = {}
    scored = []
    for alert in alerts:
        cat = alert["category"]
        # this loads each category's forecast only once so that many alerts do not repeat the same
        # query
        if run and cat not in steps_by_cat:
            steps_by_cat[cat] = repo.forecast(conn, run["id"], cat, "base")
        outlook = alert_outlook(alert["direction"], alert["target"], latest.get(cat, 0), steps_by_cat.get(cat, []))
        scored.append({**alert, "latest_premium": latest.get(cat, 0), **outlook})
    return scored


# this returns one visitor's watchlist so that nobody sees someone else's targets
@router.get("", response_model=list[Alert])
def list_alerts(client_id: UUID, conn: Connection = Depends(get_connection)):
    return _score(conn, repo.list_alerts(conn, str(client_id)))


# this adds a target so that it can be scored against each new forecast
@router.post("", response_model=Alert, status_code=status.HTTP_201_CREATED)
def create_alert(alert: AlertIn, conn: Connection = Depends(get_connection)):
    cid = str(alert.client_id)
    # this rejects duplicates and caps the list so that one client cannot fill the table
    if repo.find_alert(conn, cid, alert.category, alert.direction, alert.target):
        raise HTTPException(status_code=409, detail=f"You're already watching Cat {alert.category} "
                                                    f"{alert.direction} ${alert.target:,}.")
    if repo.count_alerts(conn, cid) >= settings.max_alerts_per_client:
        raise HTTPException(status_code=429, detail="Watchlist limit reached. Remove a target first.")
    label = (alert.label or "").strip() or None
    row = repo.create_alert(conn, cid, alert.category, alert.direction, alert.target, label)
    return _score(conn, [row])[0]


# this removes a target, the client id must match so that nobody can delete someone else's
@router.delete("/{alert_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_alert(alert_id: int, client_id: UUID, conn: Connection = Depends(get_connection)):
    if not repo.delete_alert(conn, alert_id, str(client_id)):
        raise HTTPException(status_code=404, detail="Alert not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
