"""Decision support: turning probabilistic forecasts into advice.

Rules (from the project proposal):
  * WAIT     – the median (p50) forecast at the end of the horizon (one quota
               quarter, 6 exercises) is at least ``threshold`` (default 8%)
               below the latest premium.
  * BUY NOW  – otherwise; waiting is not expected to save enough money to
               justify the risk that prices rise instead.

The advice also carries the probability that prices will actually be lower,
read from the forecast distribution, so the user sees how confident it is.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..labels import exercise_label
from . import quantiles as qt


@dataclass
class Advice:
    action: str                 # "wait" | "buy_now"
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


def advise(category_name: str, current: float, steps: list[dict], history: list[dict],
           threshold: float) -> Advice:
    """``steps``: forecast rows ordered by step; ``history``: recent exercises, oldest first."""
    end = steps[-1]
    end_values = qt.row_values(end)
    change = end["q50"] / current - 1.0
    prob_lower = qt.cdf(end_values, current)
    cheapest = min(steps, key=lambda s: s["q50"])
    horizon_label = exercise_label(end["month"], end["bidding_no"])

    if change <= -threshold:
        action, confidence = "wait", prob_lower
        headline = "Wait"
        summary = (f"{category_name} is expected to fall about {abs(change) * 100:.0f}% by {horizon_label}. "
                   f"There is a {prob_lower * 100:.0f}% chance it ends up below today's premium.")
    else:
        action, confidence = "buy_now", 1.0 - prob_lower
        headline = "Buy now"
        if change >= 0.03:
            summary = (f"{category_name} is more likely to rise (about {change * 100:+.0f}% by {horizon_label}), "
                       "so waiting would probably cost more.")
        else:
            summary = (f"No meaningful drop is expected for {category_name} "
                       f"({change * 100:+.1f}% by {horizon_label}), below the {threshold * 100:.0f}% "
                       "saving needed to justify waiting.")

    return Advice(
        action=action, headline=headline, summary=summary,
        expected_change_pct=round(change * 100, 2), prob_lower_pct=round(prob_lower * 100, 1),
        confidence_pct=round(confidence * 100, 1), current=current, horizon_label=horizon_label,
        horizon_q10=end["q10"], horizon_q50=end["q50"], horizon_q90=end["q90"],
        cheapest_label=exercise_label(cheapest["month"], cheapest["bidding_no"]),
        cheapest_q50=cheapest["q50"], threshold_pct=threshold * 100,
        reasons=market_reasons(current, steps, history),
    )


def market_reasons(current: float, steps: list[dict], history: list[dict]) -> list[str]:
    """Short, plain-English drivers behind the forecast."""
    reasons = []
    if len(history) >= 24:
        ratio_now = history[-1]["bids_received"] / max(history[-1]["quota"], 1)
        ratio_avg = sum(h["bids_received"] / max(h["quota"], 1) for h in history[-24:]) / 24
        trend = ("higher than" if ratio_now > ratio_avg * 1.05
                 else "lower than" if ratio_now < ratio_avg * 0.95 else "in line with")
        reasons.append(f"Demand pressure: {ratio_now:.2f} bids per COE, {trend} the one-year average of {ratio_avg:.2f}.")

        quota_now = history[-1]["quota"]
        quota_year_ago = history[-24]["quota"]
        change = quota_now / max(quota_year_ago, 1) - 1
        reasons.append(f"Supply: quota is {quota_now:,} per exercise, {change * 100:+.0f}% versus a year ago.")

    end = steps[-1]
    width = (end["q90"] - end["q10"]) / current * 100
    reasons.append(f"Uncertainty: 80% of outcomes fall within ${end['q10']:,.0f}–${end['q90']:,.0f} "
                   f"(±{width / 2:.0f}%).")
    return reasons


def alert_outlook(direction: str, target: float, latest: float, steps: list[dict]) -> dict:
    """How likely an alert is to trigger within the forecast horizon."""
    if (direction == "below" and latest <= target) or (direction == "above" and latest >= target):
        return {"status": "triggered", "probability_pct": 100.0, "when": None}

    best_p, best_step = 0.0, None
    for step in steps:
        p = qt.cdf(qt.row_values(step), target)
        p = p if direction == "below" else 1.0 - p
        if p > best_p:
            best_p, best_step = p, step
    status = "likely" if best_p >= 0.5 else "possible" if best_p >= 0.2 else "unlikely"
    when = exercise_label(best_step["month"], best_step["bidding_no"]) if best_step else None
    return {"status": status, "probability_pct": round(best_p * 100, 1), "when": when}
