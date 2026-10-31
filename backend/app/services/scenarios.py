"""Supply scenarios: the forecast under a different quota for the next quarter.

The ML job stores a forecast for five quota multipliers (-20%, -10%, as
announced, +10%, +20%). The Scenario Lab lets the viewer pick any whole
percentage in that range; values between two modelled points are a straight
line between their quantiles. Nothing is extrapolated beyond the modelled range.
"""

from __future__ import annotations

from sqlalchemy.engine import Connection

from ..labels import SCENARIOS
from . import quantiles as qt
from . import repository as repo

# this builds [(-20, "quota_minus_20"), ..., (0, "base"), ..., (20, "quota_plus_20")] from the
# labels so that the percent list never goes out of sync with them
MODELLED = sorted((round((meta["multiplier"] - 1) * 100), key) for key, meta in SCENARIOS.items())
# these are the limits and lookups so that percent and scenario id can be swapped either way
MIN_PCT, MAX_PCT = MODELLED[0][0], MODELLED[-1][0]
_BY_PCT = dict(MODELLED)
PCT_OF = {key: pct for pct, key in MODELLED}


def label(pct: int) -> str:
    """'As announced', '+15% supply', '−15% supply' (same wording as the modelled scenarios)."""
    if pct in _BY_PCT:
        return SCENARIOS[_BY_PCT[pct]]["label"]
    return f"{'+' if pct > 0 else '−'}{abs(pct)}% supply"


def scenario_id(pct: int) -> str | None:
    """The stored scenario for a modelled percentage, else None (an interpolated point)."""
    return _BY_PCT.get(pct)


def steps_for(conn: Connection, run_id: int, category: str, pct: int,
              load=None) -> list[dict]:
    """Forecast rows for a quota change of ``pct`` percent (clamped to the modelled range).

    ``load(scenario)`` may be given to reuse rows the caller already holds.
    """
    # this uses the loader passed in or the database so that callers holding rows can skip a query
    load = load or (lambda scenario: repo.forecast(conn, run_id, category, scenario))
    # this keeps pct inside the modelled range so that nothing is extrapolated
    pct = max(MIN_PCT, min(MAX_PCT, int(pct)))
    # this returns the stored forecast for a modelled point so that no maths is needed
    if pct in _BY_PCT:
        return load(_BY_PCT[pct])
    # this finds the two modelled points around pct so that we can draw a line between them
    lo = max(p for p, _ in MODELLED if p < pct)
    hi = min(p for p, _ in MODELLED if p > pct)
    a, b = load(_BY_PCT[lo]), load(_BY_PCT[hi])
    if not a or not b:
        return []
    # this is how far pct sits between them so that each quantile can be mixed by that share
    w = (pct - lo) / (hi - lo)
    mix = lambda x, y: x + (y - x) * w  # noqa: E731
    out = []
    for sa, sb in zip(a, b):
        row = {**sa, **{c: mix(float(sa[c]), float(sb[c])) for c in qt.COLUMNS}}
        if sa.get("quota") is not None and sb.get("quota") is not None:
            row["quota"] = round(mix(sa["quota"], sb["quota"]))
        out.append(row)
    return out
