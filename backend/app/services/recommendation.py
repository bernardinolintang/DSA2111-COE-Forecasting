"""Decision support: turning probabilistic forecasts into a market outlook.

The app describes where premiums are heading and how sure the model is. It does
not tell anyone to buy or to wait: a forecast of one cost component cannot make
that call, so the evidence is shown and the decision is left to the reader.

The outlook is read from the forecast distribution at the end of the horizon
(one quota quarter, 6 exercises):

  * ``prob_lower``  – P(premium at the horizon < today)
  * ``outlook``     – which way the odds lean, and how clearly:
        easing   P(lower)  >= 65%   "Downward pressure"
        softer   P(lower)  >= 55%   "Slight downward pressure"
        firmer   P(higher) >= 55%   "Slight upward pressure"
        rising   P(higher) >= 65%   "Upward pressure"
        steady   otherwise          "No clear direction"
  * ``prob_drop``   – P(premium at the horizon <= today x (1 - threshold)), the
                      chance of a drop big enough to matter (default 8%, the
                      saving the project proposal treats as worth waiting for).
  * ``uncertainty`` – how wide the 80% range is at the horizon, as a share of
                      today's premium: low (< ±8%), moderate (up to ±15%), high.

Because COE premiums are close to a random walk, "No clear direction" is the
usual outcome. That is the honest reading of a flat, uncertain forecast.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..labels import exercise_label
from . import quantiles as qt

CLEAR, SLIGHT = 0.65, 0.55         # how far the odds must lean before a direction is called
LOW_WIDTH, MODERATE_WIDTH = 8.0, 15.0     # half-width of the 80% range, % of today's premium

# this maps each outlook code to its wording so that all pages describe it the same way
OUTLOOKS = {
    "easing": {"label": "Downward pressure", "direction": "down", "strength": "strong"},
    "softer": {"label": "Slight downward pressure", "direction": "down", "strength": "slight"},
    "steady": {"label": "No clear direction", "direction": "flat", "strength": "none"},
    "firmer": {"label": "Slight upward pressure", "direction": "up", "strength": "slight"},
    "rising": {"label": "Upward pressure", "direction": "up", "strength": "strong"},
}


# this holds everything the outlook needs so that routers can send it straight to the API
@dataclass
class Advice:
    outlook: str                # "easing" | "softer" | "steady" | "firmer" | "rising"
    label: str                  # the outlook in words, e.g. "Slight downward pressure"
    direction: str              # "down" | "flat" | "up"
    strength: str               # "strong" | "slight" | "none"
    summary: str
    expected_change_pct: float
    prob_lower_pct: float
    prob_higher_pct: float
    prob_drop_pct: float        # chance of a drop of at least threshold_pct
    meaningful_drop: bool       # the median itself is at least threshold_pct below today
    uncertainty: str            # "low" | "moderate" | "high"
    uncertainty_pct: float      # half-width of the 80% range at the horizon, % of today's premium
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
    drivers: list[dict]
    reasons: list[str]


# this turns the chance of a lower premium into one of five outlooks so that small leans stay "No
# clear direction"
def outlook_for(prob_lower: float) -> str:
    prob_higher = 1.0 - prob_lower
    if prob_lower >= CLEAR:
        return "easing"
    if prob_lower >= SLIGHT:
        return "softer"
    if prob_higher >= CLEAR:
        return "rising"
    if prob_higher >= SLIGHT:
        return "firmer"
    return "steady"


# this turns the width of the range into a word so that the page can say how sure the model is
def uncertainty_for(width_pct: float) -> str:
    return "low" if width_pct < LOW_WIDTH else "moderate" if width_pct <= MODERATE_WIDTH else "high"


def advise(category_name: str, current: float, steps: list[dict], history: list[dict],
           threshold: float) -> Advice:
    """``steps``: forecast rows ordered by step; ``history``: recent exercises, oldest first."""
    # this reads the odds from the last forecast step so that the outlook covers one quota quarter
    nxt, end = steps[0], steps[-1]
    end_values = qt.row_values(end)
    change = end["q50"] / current - 1.0
    prob_lower = qt.cdf(end_values, current)
    prob_higher = 1.0 - prob_lower
    prob_drop = qt.cdf(end_values, current * (1.0 - threshold))
    cheapest = min(steps, key=lambda s: s["q50"])
    horizon_label = exercise_label(end["month"], end["bidding_no"])
    # this works out half the range as a percent of today so that uncertainty is easy to compare
    width = (end["q90"] - end["q10"]) / current * 50

    level = outlook_for(prob_lower)
    # this writes the median sentence first so that each outlook below can reuse it
    if abs(change) < 0.005:
        median = f"the most likely premium by {horizon_label} is about the same as today"
    else:
        median = (f"the most likely premium by {horizon_label} is {abs(change) * 100:.1f}% "
                  f"{'lower' if change < 0 else 'higher'} than today")
    # this picks the wording for each outlook so that the summary reads like a person wrote it
    if level == "easing":
        lead = (f"{category_name} premiums are more likely to fall than rise: {median}, with a "
                f"{prob_lower * 100:.0f}% chance of a lower premium.")
    elif level == "softer":
        lead = (f"Slight downward pressure on {category_name}: {median}, with a "
                f"{prob_lower * 100:.0f}% chance of a lower premium.")
    elif level == "rising":
        lead = (f"{category_name} premiums are more likely to rise than fall: {median}, with a "
                f"{prob_higher * 100:.0f}% chance of a higher premium.")
    elif level == "firmer":
        lead = (f"Slight upward pressure on {category_name}: {median}, with a "
                f"{prob_higher * 100:.0f}% chance of a higher premium.")
    else:
        lead = f"No clear direction for {category_name}: {median}, and a fall is about as likely as a rise."
    summary = f"{lead} A drop of {threshold * 100:.0f}% or more has a {prob_drop * 100:.0f}% chance."

    drivers = market_drivers(current, steps, history)
    return Advice(
        outlook=level, summary=summary, **OUTLOOKS[level],
        expected_change_pct=round(change * 100, 2), prob_lower_pct=round(prob_lower * 100, 1),
        prob_higher_pct=round(prob_higher * 100, 1), prob_drop_pct=round(prob_drop * 100, 1),
        meaningful_drop=change <= -threshold,
        uncertainty=uncertainty_for(width), uncertainty_pct=round(width, 1), current=current,
        next_label=exercise_label(nxt["month"], nxt["bidding_no"]),
        next_q10=nxt["q10"], next_q50=nxt["q50"], next_q90=nxt["q90"],
        horizon_label=horizon_label,
        horizon_q10=end["q10"], horizon_q50=end["q50"], horizon_q90=end["q90"],
        cheapest_label=exercise_label(cheapest["month"], cheapest["bidding_no"]),
        cheapest_q50=cheapest["q50"], threshold_pct=threshold * 100,
        drivers=drivers, reasons=[f"{d['title']}: {d['text']}." for d in drivers],
    )


def market_drivers(current: float, steps: list[dict], history: list[dict]) -> list[dict]:
    """The evidence behind the outlook: demand, supply and how wide the forecast is.

    Each driver has a ``trend`` ("up" | "down" | "flat", or the uncertainty level), the
    number behind it and a plain-English sentence.
    """
    drivers = []
    # this needs a year of history so that demand and quota can be compared with last year
    if len(history) >= 24:
        # this compares bids per COE now with the past year so that we can say if demand is hot
        ratio_now = history[-1]["bids_received"] / max(history[-1]["quota"], 1)
        ratio_avg = sum(h["bids_received"] / max(h["quota"], 1) for h in history[-24:]) / 24
        trend = "up" if ratio_now > ratio_avg * 1.05 else "down" if ratio_now < ratio_avg * 0.95 else "flat"
        words = {"up": "higher than", "down": "lower than", "flat": "in line with"}[trend]
        drivers.append({"key": "demand", "title": "Demand pressure", "trend": trend, "value": round(ratio_now, 2),
                        "text": f"{ratio_now:.2f} bids per COE, {words} the one-year average of {ratio_avg:.2f}"})

        # this compares the quota with a year ago so that we can say if supply is growing
        quota_now = history[-1]["quota"]
        quota_year_ago = history[-24]["quota"]
        change = (quota_now / max(quota_year_ago, 1) - 1) * 100
        trend = "up" if change > 2 else "down" if change < -2 else "flat"
        drivers.append({"key": "quota", "title": "Supply", "trend": trend, "value": round(change, 1),
                        "text": f"quota is {quota_now:,} per exercise, {change:+.0f}% versus a year ago"})

    # this always adds the uncertainty driver so that the width of the range is visible on every
    # card
    end = steps[-1]
    width = (end["q90"] - end["q10"]) / current * 50
    drivers.append({"key": "uncertainty", "title": "Uncertainty", "trend": uncertainty_for(width),
                    "value": round(width, 1),
                    "text": f"80% of outcomes fall within ${end['q10']:,.0f}–${end['q90']:,.0f} (±{width:.0f}%)"})
    return drivers


def signal(advice: Advice) -> dict:
    """The compact outlook shown on the Overview cards and the market status bar."""
    keys = ("outlook", "label", "direction", "strength", "summary", "expected_change_pct", "prob_lower_pct",
            "prob_higher_pct", "prob_drop_pct", "uncertainty", "uncertainty_pct", "drivers")
    return {k: getattr(advice, k) for k in keys}


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
    # this returns straight away if the target is already reached so that the watchlist shows it as
    # triggered
    if (direction == "below" and latest <= target) or (direction == "above" and latest >= target):
        return {"status": "triggered", "probability_pct": 100.0, "when": None, **context}

    # this finds the step with the best chance so that we can say when the target is most likely
    best_p, best_step = 0.0, None
    for step in steps:
        p = qt.cdf(qt.row_values(step), target)
        p = p if direction == "below" else 1.0 - p
        if p > best_p:
            best_p, best_step = p, step
    # this turns the chance into a word so that the list stays easy to read
    status = "likely" if best_p >= 0.5 else "possible" if best_p >= 0.2 else "unlikely"
    when = exercise_label(best_step["month"], best_step["bidding_no"]) if best_step else None
    return {"status": status, "probability_pct": round(best_p * 100, 1), "when": when, **context}
