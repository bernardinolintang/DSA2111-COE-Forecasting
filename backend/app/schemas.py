"""Pydantic response / request models. They also generate the OpenAPI docs at /api/docs."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

CategoryCode = Literal["A", "B", "C", "D", "E"]


class RunInfo(BaseModel):
    id: int
    created_at: datetime
    finished_at: datetime | None = None
    model_name: str
    data_through: date | None = None
    last_bidding: int | None = None
    duration_s: float | None = None


class RunDetail(RunInfo):
    params: dict = {}
    metrics: dict = {}


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    database: bool
    latest_run: RunInfo | None
    version: str


class Category(BaseModel):
    code: CategoryCode
    name: str
    title: str
    description: str


class Exercise(BaseModel):
    month: date
    bidding_no: int
    label: str


class HistoryPoint(Exercise):
    premium: int
    quota: int
    bids_received: int
    bids_success: int


class History(BaseModel):
    category: CategoryCode
    points: list[HistoryPoint]


class ForecastStep(Exercise):
    step: int
    quota: int | None
    q05: float
    q10: float
    q25: float
    q50: float
    q75: float
    q90: float
    q95: float


class Forecast(BaseModel):
    category: CategoryCode
    scenario: str
    run: RunInfo
    origin: HistoryPoint
    steps: list[ForecastStep]


class Scenario(BaseModel):
    id: str
    label: str
    multiplier: float
    description: str


class Signal(BaseModel):
    action: Literal["wait", "buy_now"]
    headline: str
    expected_change_pct: float
    prob_lower_pct: float


class CategorySummary(Category):
    latest: HistoryPoint
    previous_premium: int | None
    change: int | None
    change_pct: float | None
    year_ago_pct: float | None
    sparkline: list[int]
    next_q50: float | None
    horizon_q10: float | None
    horizon_q50: float | None
    horizon_q90: float | None
    horizon_label: str | None
    signal: Signal | None


class Summary(BaseModel):
    run: RunInfo | None
    data_through: Exercise | None
    categories: list[CategorySummary]


class Recommendation(BaseModel):
    category: CategoryCode
    scenario: str
    action: Literal["wait", "buy_now"]
    headline: str
    summary: str
    expected_change_pct: float
    prob_lower_pct: float
    confidence_pct: float
    current: float
    horizon_label: str
    horizon_q10: float
    horizon_q50: float
    horizon_q90: float
    cheapest_label: str
    cheapest_q50: float
    threshold_pct: float
    reasons: list[str]


class BidPoint(BaseModel):
    bid: float
    probability_pct: float


class BidSuggestion(BaseModel):
    confidence_pct: int
    bid: float


class BidPlan(BaseModel):
    category: CategoryCode
    exercise: Exercise
    bid: float
    win_probability_pct: float
    expected_premium: float
    suggestions: list[BidSuggestion]
    curve: list[BidPoint]


class PolicyEffect(BaseModel):
    category: CategoryCode
    pct_effect: float
    pct_low: float | None
    pct_high: float | None
    p_value: float | None
    significant: bool


class PolicyEvent(BaseModel):
    code: str
    name: str
    effective_month: date
    end_month: date | None
    kind: str
    categories: list[str]
    description: str
    source_url: str | None
    effects: list[PolicyEffect]


class ModelScore(BaseModel):
    model: str
    label: str
    category: str
    horizon: int
    n: int
    mae: float
    rmse: float
    mape: float
    smape: float
    pinball: float
    coverage80: float
    direction: float | None


class Metrics(BaseModel):
    run: RunDetail
    test_period: dict
    leaderboard: list[ModelScore]
    by_horizon: list[ModelScore]
    by_category: list[ModelScore]


class BacktestPoint(Exercise):
    actual: float
    q10: float | None
    q50: float
    q90: float | None


class Backtest(BaseModel):
    category: CategoryCode
    model: str
    horizon: int
    points: list[BacktestPoint]


class Importance(BaseModel):
    variable: str
    label: str
    importance: float


class Interpretability(BaseModel):
    encoder: list[Importance]
    decoder: list[Importance]
    attention: dict[str, list[dict]]


class AlertIn(BaseModel):
    client_id: UUID
    category: CategoryCode
    direction: Literal["below", "above"]
    target: int = Field(gt=0, lt=1_000_000)
    label: str | None = Field(default=None, max_length=80)


class Alert(BaseModel):
    id: int
    category: CategoryCode
    direction: Literal["below", "above"]
    target: int
    label: str | None
    created_at: datetime
    latest_premium: int
    status: Literal["triggered", "likely", "possible", "unlikely"]
    probability_pct: float
    when: str | None
