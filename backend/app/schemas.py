"""Pydantic response / request models. They also generate the OpenAPI docs at /api/docs."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

# this limits category codes to A-E so that a bad code is rejected at the API edge
CategoryCode = Literal["A", "B", "C", "D", "E"]


# this is the run info shown under forecasts so that users can see which run made them
class RunInfo(BaseModel):
    id: int
    created_at: datetime
    finished_at: datetime | None = None
    model_name: str
    data_through: date | None = None
    last_bidding: int | None = None
    duration_s: float | None = None


# this adds the settings and metrics for pages that need the full run
class RunDetail(RunInfo):
    params: dict = {}
    metrics: dict = {}


# this is the health check response so that Docker and Kubernetes can read the status
class Health(BaseModel):
    status: Literal["ok", "degraded"]
    database: bool
    latest_run: RunInfo | None
    version: str


# this describes one category so that the front end can label it
class Category(BaseModel):
    code: CategoryCode
    name: str
    title: str
    description: str


# this is one bidding exercise so that other models can extend it
class Exercise(BaseModel):
    month: date
    bidding_no: int
    label: str


# this adds the recorded results of an exercise so that charts have the real numbers
class HistoryPoint(Exercise):
    premium: int
    quota: int
    bids_received: int
    bids_success: int


# this is one category's history so that the chart gets all its points in one reply
class History(BaseModel):
    category: CategoryCode
    points: list[HistoryPoint]


# this is one forecast step with its quantiles so that the page can draw the ranges
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


# this is the full forecast response so that the fan chart has its run, start point and steps
class Forecast(BaseModel):
    category: CategoryCode
    scenario: str                      # a modelled scenario id, or "custom" for an interpolated point
    quota_pct: int = 0                 # next quarter's quota change, percent
    run: RunInfo
    origin: HistoryPoint
    steps: list[ForecastStep]


# this describes one supply scenario so that the page can build its controls
class Scenario(BaseModel):
    id: str
    label: str
    multiplier: float
    quota_pct: int
    description: str


Outlook = Literal["easing", "softer", "steady", "firmer", "rising"]


# this is one piece of evidence behind an outlook so that cards can show it as a chip
class Driver(BaseModel):
    key: Literal["demand", "quota", "uncertainty"]
    title: str
    trend: str                         # up | down | flat, or the uncertainty level
    value: float
    text: str


# this is the compact outlook so that cards can show it without the full detail
class Signal(BaseModel):
    """The market outlook: which way the forecast leans and how clearly. Not advice."""
    outlook: Outlook
    label: str
    direction: Literal["down", "flat", "up"]
    strength: Literal["strong", "slight", "none"]
    summary: str
    expected_change_pct: float
    prob_lower_pct: float
    prob_higher_pct: float
    prob_drop_pct: float
    uncertainty: Literal["low", "moderate", "high"]
    uncertainty_pct: float
    drivers: list[Driver]


# this is a category plus its market numbers so that the home page needs one request
class CategorySummary(Category):
    latest: HistoryPoint
    previous_premium: int | None
    change: int | None
    change_pct: float | None
    year_ago_pct: float | None
    sparkline: list[int]
    next_label: str | None
    next_q10: float | None
    next_q50: float | None
    next_q90: float | None
    horizon_q10: float | None
    horizon_q50: float | None
    horizon_q90: float | None
    horizon_label: str | None
    signal: Signal | None


# this is the whole home page response so that one call fills the page
class Summary(BaseModel):
    run: RunInfo | None
    data_through: Exercise | None
    next_exercise: Exercise | None
    categories: list[CategorySummary]


# this is the full outlook so that the Forecast page can show all the evidence
class Recommendation(Signal):
    category: CategoryCode
    scenario: str
    quota_pct: int = 0
    meaningful_drop: bool
    current: float
    next_label: str
    next_q10: float
    next_q50: float
    next_q90: float
    horizon_label: str
    horizon_q10: float
    horizon_q50: float
    horizon_q90: float
    cheapest_label: str
    cheapest_q50: float
    threshold_pct: float
    reasons: list[str]


# this is one point on the win curve so that the bid chart can be drawn
class BidPoint(BaseModel):
    bid: float
    probability_pct: float


# this is one suggested bid so that the page can list quick picks
class BidSuggestion(BaseModel):
    confidence_pct: int
    bid: float


# this is the bid planner response so that one call fills the page
class BidPlan(BaseModel):
    category: CategoryCode
    exercise: Exercise
    bid: float
    win_probability_pct: float
    expected_premium: float
    q10: float
    q25: float
    q75: float
    q90: float
    suggestions: list[BidSuggestion]
    curve: list[BidPoint]


# this is one estimated policy effect so that the Policy Lab can draw its bars
class PolicyEffect(BaseModel):
    category: CategoryCode
    pct_effect: float
    pct_low: float | None
    pct_high: float | None
    p_value: float | None
    significant: bool


# this is a policy event with its effects so that the timeline has both
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


# this is one model's score so that the leaderboard can list them
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


# this is the model page response so that all the tables come in one call
class Metrics(BaseModel):
    run: RunDetail
    test_period: dict
    leaderboard: list[ModelScore]
    by_horizon: list[ModelScore]
    by_category: list[ModelScore]


# this is one predicted against actual point so that the chart can be drawn
class BacktestPoint(Exercise):
    actual: float
    q10: float | None
    q50: float
    q90: float | None


# this is a backtest series so that the page knows which model and horizon it shows
class Backtest(BaseModel):
    category: CategoryCode
    model: str
    horizon: int
    points: list[BacktestPoint]


# this is one variable's importance so that the chart has a label and a value
class Importance(BaseModel):
    variable: str
    label: str
    importance: float


# this is the interpretability response so that past inputs, future inputs and attention come
# together
class Interpretability(BaseModel):
    encoder: list[Importance]
    decoder: list[Importance]
    attention: dict[str, list[dict]]


# this is one glossary entry so that popovers get both explanation levels
class GlossaryTerm(BaseModel):
    id: str
    term: str
    simple: str
    technical: str


# this says which analyst mode is on so that the panel can show it
class AnalystStatus(BaseModel):
    mode: Literal["llm", "offline"]
    provider: Literal["groq", "anthropic", "offline"]
    model: str | None


# this is one chat message so that the conversation has a clear shape
class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)


# this is where the viewer is so that the server can rebuild the numbers itself
class AnalystView(BaseModel):
    """Where the viewer is. Only identifiers: the numbers are re-read on the server."""
    page: Literal["overview", "forecast", "scenario", "bid", "plan", "policy", "model", "alerts", "learn"] = "overview"
    category: CategoryCode | None = None
    scenario: Literal["base", "quota_minus_20", "quota_minus_10", "quota_plus_10", "quota_plus_20"] | None = None
    quota_pct: int | None = Field(default=None, ge=-20, le=20)       # the Scenario Lab slider
    bid: float | None = Field(default=None, gt=0, lt=10_000_000)
    event: str | None = Field(default=None, max_length=64)


# this is one analyst request so that the size of the chat can be limited
class AnalystRequest(BaseModel):
    messages: list[ChatTurn] = Field(min_length=1, max_length=30)
    view: AnalystView = AnalystView()
    client_id: UUID | None = None

    @field_validator("messages")
    @classmethod
    def _last_is_question(cls, messages: list[ChatTurn]) -> list[ChatTurn]:
        if messages[-1].role != "user":
            raise ValueError("the last message must be the user's question")
        if len(messages[-1].content) > 1000:
            raise ValueError("questions are limited to 1,000 characters")
        return messages


# this is one app action so that the browser knows what to do and if it needs Confirm
class AnalystAction(BaseModel):
    type: Literal["navigate", "set_supply_scenario", "set_bid_amount", "highlight", "open_tutorial",
                  "prepare_watch", "prepare_remove_watch"]
    params: dict
    confirm: bool
    summary: str


# this is the analyst reply so that text, actions and source line arrive together
class AnalystReply(BaseModel):
    reply: str
    actions: list[AnalystAction]
    mode: Literal["llm", "offline"]
    provenance: str | None
    notice: str | None


# this is what a user sends to save a target so that the inputs can be checked
class AlertIn(BaseModel):
    client_id: UUID
    category: CategoryCode
    direction: Literal["below", "above"]
    target: int = Field(gt=0, lt=1_000_000)
    label: str | None = Field(default=None, max_length=80)


# this is a saved target with its score so that the watchlist can show the odds
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
    next_label: str | None = None
    next_q50: float | None = None
    horizon_label: str | None = None
    horizon_q50: float | None = None
