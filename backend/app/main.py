"""FastAPI application: the REST API behind the COE Compass web app.

Run locally:   uvicorn app.main:app --reload
Docs:          http://localhost:8000/api/docs
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy.engine import Connection

from .config import settings
from .db import get_connection, ping, wait_and_migrate
from .routers import alerts, analyst, forecast, market, model, policy
from .schemas import Health
from .services import repository as repo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    wait_and_migrate()
    yield


app = FastAPI(
    title="COE Compass API",
    description="Policy-aware probabilistic forecasts of Singapore COE premiums "
                "(Box-Tiao intervention analysis + Temporal Fusion Transformer). An independent "
                "decision-support service built on public data; not affiliated with LTA.",
    version=settings.version,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["GET", "POST", "DELETE"],
                   allow_headers=["*"])

api = APIRouter(prefix="/api")


@api.get("/health", response_model=Health, tags=["system"])
def health(conn: Connection = Depends(get_connection)):
    """Liveness / readiness probe used by Docker and Kubernetes."""
    db_ok = ping(conn)
    run = repo.latest_run(conn) if db_ok else None
    return {"status": "ok" if db_ok else "degraded", "database": db_ok, "latest_run": run,
            "version": settings.version}


for router in (market.router, forecast.router, policy.router, model.router, alerts.router, analyst.router):
    api.include_router(router)
app.include_router(api)
