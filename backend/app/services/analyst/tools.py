"""Read-only data tools the analyst can call. They return plain dicts of numbers
computed with the same quantile maths the pages use."""

from __future__ import annotations

from datetime import date

from sqlalchemy.engine import Connection

from ...glossary import glossary
from ...labels import exercise_label
from .. import quantiles as qt
from .. import repository as repo
from .. import scenarios as sc
from ..recommendation import alert_outlook
from .actions import ActionError, _amount, _category, quota_pct
from .context import AnalystContext, load_steps, outlook_dict, recommendation_for, steps_for_quota


def _next(conn: Connection, ctx: AnalystContext, cat: str) -> dict:
    steps = load_steps(conn, ctx, cat, "base")
    if not steps:
        raise ActionError("No forecast is available for this category yet.")
    return steps[0]


def run(conn: Connection, ctx: AnalystContext, name: str, params: dict) -> dict:
    p = params or {}
    if name == "bid_win_probability":
        cat, bid = _category(p.get("category")), _amount(p.get("bid"), "bid")
        nxt = _next(conn, ctx, cat)
        return {"category": f"Cat {cat}", "exercise": exercise_label(nxt["month"], nxt["bidding_no"]), "bid": bid,
                "win_probability_pct": round(qt.cdf(qt.row_values(nxt), bid) * 100, 1),
                "expected_premium_median": round(nxt["q50"])}

    if name == "bid_for_probability":
        cat = _category(p.get("category"))
        try:
            prob = float(p.get("probability_pct"))
        except (TypeError, ValueError):
            raise ActionError("probability_pct must be a number.") from None
        if not 1 <= prob <= 99:
            raise ActionError("probability_pct must be between 1 and 99.")
        nxt = _next(conn, ctx, cat)
        return {"category": f"Cat {cat}", "exercise": exercise_label(nxt["month"], nxt["bidding_no"]),
                "probability_pct": prob, "bid": round(qt.quantile(qt.row_values(nxt), prob / 100)),
                "expected_premium_median": round(nxt["q50"])}

    if name == "scenario_forecast":
        cat, pct = _category(p.get("category")), quota_pct(p)
        steps = steps_for_quota(conn, ctx, cat, pct)
        if not steps:
            raise ActionError("No forecast stored for this category / scenario.")
        advice = recommendation_for(ctx, cat, steps)
        return {"category": f"Cat {cat}", "scenario": sc.label(pct), "interpolated": sc.scenario_id(pct) is None,
                "steps": [{"exercise": exercise_label(s["month"], s["bidding_no"]), "quota_assumed": s["quota"],
                           "p10": round(s["q10"]), "median": round(s["q50"]), "p90": round(s["q90"])} for s in steps],
                "outlook": outlook_dict(advice, summary=False)}

    if name == "target_outlook":
        cat = _category(p.get("category"))
        direction = p.get("direction")
        if direction not in ("below", "above"):
            raise ActionError("direction must be 'below' or 'above'.")
        target = _amount(p.get("target"), "target")
        latest = ctx.latest.get(cat, {}).get("premium", 0)
        o = alert_outlook(direction, target, latest, load_steps(conn, ctx, cat, "base"))
        return {"category": f"Cat {cat}", "direction": direction, "target": target, "latest_premium": latest,
                "status": o["status"], "chance_within_quarter_pct": o["probability_pct"],
                "most_likely_by": o["when"]}

    if name == "history_summary":
        cat = _category(p.get("category"))
        years = int(p.get("years") or 0)
        since = None
        if years > 0:
            today = date.today()
            since = date(today.year - years, today.month, 1)
        rows = repo.history(conn, cat, since)
        if not rows:
            raise ActionError("No history for that period.")
        label = lambda r: exercise_label(r["month"], r["bidding_no"])  # noqa: E731
        lo = min(rows, key=lambda r: r["premium"])
        hi = max(rows, key=lambda r: r["premium"])
        return {"category": f"Cat {cat}", "period": f"{label(rows[0])} to {label(rows[-1])}", "exercises": len(rows),
                "lowest": {"premium": lo["premium"], "exercise": label(lo)},
                "highest": {"premium": hi["premium"], "exercise": label(hi)},
                "average": round(sum(r["premium"] for r in rows) / len(rows)),
                "first": rows[0]["premium"], "latest": rows[-1]["premium"],
                "change_over_period_pct": round((rows[-1]["premium"] / rows[0]["premium"] - 1) * 100, 1)}

    if name == "explain_term":
        term = glossary().get(str(p.get("term")))
        if not term:
            raise ActionError("Unknown term; use one of the listed ids.")
        return {"term": term["term"], "simple": term["simple"], "technical": term["technical"]}

    raise ActionError(f"Unknown tool {name!r}.")
