"""Decision support: turning probabilistic forecasts into advice.

Rules (from the project proposal):
  * WAIT     – the median (p50) forecast at the end of the horizon (one quota
               quarter, 6 exercises) is at least ``threshold`` (default 8%)
               below the latest premium.
  * BUY NOW  – otherwise; waiting is not expected to save enough money to
               justify the risk that prices rise instead.

The advice also carries the probabilities behind it, read from the forecast
distribution, and a *conviction* level so the UI never presents a coin flip
as a strong call:

  * ``prob_lower``   – P(premium at the horizon < today)
  * ``prob_save``    – P(premium at the horizon <= today x (1 - threshold)),
                       i.e. the chance that waiting saves at least the threshold.
                       This is the probability the Wait rule is really about.
  * ``conviction``   – how clearly the forecast supports the action:
        buy_now: P(higher) >= 65% high, >= 55% medium, otherwise low
        wait:    P(save)   >= 65% high, >= 50% medium, otherwise low
  * ``label``        – "Buy now" / "Lean buy" / "Wait" / "Lean wait": the action
                       (unchanged) worded by conviction.

Because COE premiums are close to a random walk, the median rarely moves 8% in
one quarter, so Buy now is the usual outcome of the rule. Conviction is what
tells a flat, uncertain "Buy now" apart from a confident one.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..labels import exercise_label
from . import quantiles as qt

HIGH, MEDIUM = 0.65, 0.55          # conviction cut-offs for buy_now (P(higher))
WAIT_MEDIUM = 0.50                 # wait is medium from 50% (the median is already below the threshold)


@dataclass
class Advice:
    action: str                 # "wait" | "buy_now"
    headline: str               # "Wait" | "Buy now" (the rule's action)
    label: str                  # action worded by conviction, e.g. "Lean buy"
    conviction: str             # "high" | "medium" | "low"
    summary: str
    expected_change_pct: float
    prob_lower_pct: float
    prob_higher_pct: float
    prob_save_pct: float
    confidence_pct: float       # P(higher) for buy_now, P(lower) for wait (kept for API compatibility)
    current: float
    horizon_label: str
    horizon_q10: float
    horizon_q50: float
    horizon_q90: float
    cheapest_label: str
    cheapest_q50: float
    threshold_pct: float
    reasons: list[str]


def conviction_for(action: str, prob_higher: float, prob_save: float) -> str:
    if action == "wait":
        return "high" if prob_save >= HIGH else "medium" if prob_save >= WAIT_MEDIUM else "low"
    return "high" if prob_higher >= HIGH else "medium" if prob_higher >= MEDIUM else "low"


def label_for(action: str, conviction: str) -> str:
    if action == "wait":
        return "Wait" if conviction == "high" else "Lean wait"
    return "Buy now" if conviction == "high" else "Lean buy"


def advise(category_name: str, current: float, steps: list[dict], history: list[dict],
           threshold: float) -> Advice:
    """``steps``: forecast rows ordered by step; ``history``: recent exercises, oldest first."""
    end = steps[-1]
    end_values = qt.row_values(end)
    change = end["q50"] / current - 1.0
    prob_lower = qt.cdf(end_values, current)
    prob_save = qt.cdf(end_values, current * (1.0 - threshold))
    cheapest = min(steps, key=lambda s: s["q50"])
    horizon_label = exercise_label(end["month"], end["bidding_no"])

    if change <= -threshold:
        action, confidence = "wait", prob_lower
        headline = "Wait"
        summary = (f"{category_name} is expected to fall about {abs(change) * 100:.0f}% by {horizon_label}. "
                   f"There is a {prob_save * 100:.0f}% chance waiting saves {threshold * 100:.0f}% or more.")
    else:
        action, confidence = "buy_now", 1.0 - prob_lower
        headline = "Buy now"
        if change >= 0.03:
            summary = (f"{category_name} is more likely to rise (about {change * 100:+.0f}% by {horizon_label}), "
                       "so waiting would probably cost more.")
        elif prob_lower > MEDIUM:
            summary = (f"{category_name} may drift lower ({change * 100:+.1f}% by {horizon_label}), but a drop "
                       f"big enough to be worth waiting for ({threshold * 100:.0f}%+) has only a "
                       f"{prob_save * 100:.0f}% chance.")
        elif 1.0 - prob_lower < MEDIUM:
            summary = (f"No clear direction for {category_name}: the median is {change * 100:+.1f}% by "
                       f"{horizon_label}, and a fall is about as likely as a rise. A drop big enough to be "
                       f"worth waiting for ({threshold * 100:.0f}%+) has a {prob_save * 100:.0f}% chance.")
        else:
            summary = (f"No meaningful drop is expected for {category_name} "
                       f"({change * 100:+.1f}% by {horizon_label}), below the {threshold * 100:.0f}% "
                       "saving needed to justify waiting.")

    conviction = conviction_for(action, 1.0 - prob_lower, prob_save)
    return Advice(
        action=action, headline=headline, label=label_for(action, conviction), conviction=conviction,
        summary=summary,
        expected_change_pct=round(change * 100, 2), prob_lower_pct=round(prob_lower * 100, 1),
        prob_higher_pct=round((1.0 - prob_lower) * 100, 1), prob_save_pct=round(prob_save * 100, 1),
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
    """How likely a watched target is to be reached within the forecast horizon.

    Also returns the next exercise and its median so the watchlist can show
    "what the forecast says next" beside each target.
    """
    nxt = steps[0] if steps else None
    context = {
        "next_label": exercise_label(nxt["month"], nxt["bidding_no"]) if nxt else None,
        "next_q50": nxt["q50"] if nxt else None,
        "horizon_label": exercise_label(steps[-1]["month"], steps[-1]["bidding_no"]) if steps else None,
        "horizon_q50": steps[-1]["q50"] if steps else None,
    }
    if (direction == "below" and latest <= target) or (direction == "above" and latest >= target):
        return {"status": "triggered", "probability_pct": 100.0, "when": None, **context}

    best_p, best_step = 0.0, None
    for step in steps:
        p = qt.cdf(qt.row_values(step), target)
        p = p if direction == "below" else 1.0 - p
        if p > best_p:
            best_p, best_step = p, step
    status = "likely" if best_p >= 0.5 else "possible" if best_p >= 0.2 else "unlikely"
    when = exercise_label(best_step["month"], best_step["bidding_no"]) if best_step else None
    return {"status": status, "probability_pct": round(best_p * 100, 1), "when": when, **context}
