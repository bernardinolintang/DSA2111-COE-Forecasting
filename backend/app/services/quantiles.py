"""Turning a handful of forecast quantiles into a usable probability distribution.

The model outputs the premium at seven quantile levels (p5 ... p95). The
cumulative distribution function (CDF) is approximated by joining those points
with straight lines, and extending the outer segments until they reach 0 and 1.
That is enough to answer the two questions buyers care about:

  * "What is the chance the premium ends up below X?"     -> ``cdf``
  * "How high must I bid to win with 90% certainty?"      -> ``quantile``
"""

from __future__ import annotations

from bisect import bisect_left

LEVELS = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95]
COLUMNS = ["q05", "q10", "q25", "q50", "q75", "q90", "q95"]


def _knots(values: list[float]) -> tuple[list[float], list[float]]:
    """Quantile values plus linear tail extensions down to p=0 and up to p=1."""
    xs = list(values)
    lo_slope = (xs[1] - xs[0]) / (LEVELS[1] - LEVELS[0]) or 1.0
    hi_slope = (xs[-1] - xs[-2]) / (LEVELS[-1] - LEVELS[-2]) or 1.0
    x0 = max(0.0, xs[0] - lo_slope * LEVELS[0])
    x1 = xs[-1] + hi_slope * (1 - LEVELS[-1])
    return [x0, *xs, x1], [0.0, *LEVELS, 1.0]


def cdf(values: list[float], x: float) -> float:
    """P(premium <= x) for a forecast given by its quantile ``values``."""
    xs, ps = _knots(values)
    if x <= xs[0]:
        return 0.0
    if x >= xs[-1]:
        return 1.0
    i = bisect_left(xs, x)
    if xs[i] == xs[i - 1]:
        return ps[i]
    frac = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
    return ps[i - 1] + frac * (ps[i] - ps[i - 1])


def quantile(values: list[float], p: float) -> float:
    """Inverse of :func:`cdf`: the premium at probability level ``p``."""
    xs, ps = _knots(values)
    p = min(max(p, 0.0), 1.0)
    i = min(max(bisect_left(ps, p), 1), len(ps) - 1)
    frac = (p - ps[i - 1]) / (ps[i] - ps[i - 1])
    return xs[i - 1] + frac * (xs[i] - xs[i - 1])


def row_values(row) -> list[float]:
    """Extract the seven quantile values from a DB row / mapping."""
    return [float(row[c]) for c in COLUMNS]
