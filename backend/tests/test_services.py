"""Unit tests for the pure decision-support logic (no database needed)."""

from datetime import date

import pytest

from app.services import quantiles as qt
from app.services.recommendation import advise, alert_outlook

VALUES = [80.0, 85.0, 92.0, 100.0, 108.0, 115.0, 120.0]     # p5 ... p95


def test_cdf_hits_every_quantile_level():
    for level, value in zip(qt.LEVELS, VALUES):
        assert qt.cdf(VALUES, value) == pytest.approx(level)


def test_cdf_and_quantile_are_inverses():
    for p in [0.02, 0.2, 0.5, 0.66, 0.97]:
        assert qt.cdf(VALUES, qt.quantile(VALUES, p)) == pytest.approx(p)


def test_cdf_is_bounded_and_monotone():
    xs = range(0, 200, 5)
    ps = [qt.cdf(VALUES, x) for x in xs]
    assert ps[0] == 0.0 and ps[-1] == 1.0
    assert all(b >= a for a, b in zip(ps, ps[1:]))


def _steps(median_path):
    """Forecast rows whose quantiles are spread ±15% around the given medians."""
    rows = []
    for i, m in enumerate(median_path, start=1):
        rows.append({"step": i, "month": date(2026, 10 + (i - 1) // 2, 1), "bidding_no": 1 + (i - 1) % 2,
                     **{c: m * f for c, f in zip(qt.COLUMNS, [0.8, 0.85, 0.92, 1.0, 1.08, 1.15, 1.2])}})
    return rows


def test_wait_when_median_drops_more_than_threshold():
    advice = advise("Cat A", 100_000, _steps([98_000, 95_000, 90_000]), [], threshold=0.08)
    assert advice.action == "wait"
    assert advice.expected_change_pct == pytest.approx(-10.0)
    assert advice.prob_lower_pct > 50


def test_buy_now_when_drop_is_small():
    advice = advise("Cat A", 100_000, _steps([99_000, 97_000, 96_000]), [], threshold=0.08)
    assert advice.action == "buy_now"
    # the median is 4% lower, so a fall is more likely than a rise: a weak buy, worded as such
    assert advice.conviction == "low" and advice.label == "Lean buy"
    assert "may drift lower" in advice.summary


def test_buy_now_when_prices_rise():
    advice = advise("Cat B", 100_000, _steps([103_000, 106_000, 110_000]), [], threshold=0.08)
    assert advice.action == "buy_now"
    assert advice.confidence_pct > 50
    assert advice.conviction == "high" and advice.label == "Buy now"


def test_flat_forecast_is_a_lean_buy_not_a_strong_one():
    """The case from the demo: median ~1% above today with wide ranges."""
    advice = advise("Cat A", 131_890, _steps([133_000, 133_300]), [], threshold=0.08)
    assert advice.action == "buy_now"            # the rule's result is unchanged ...
    assert advice.label == "Lean buy"            # ... but it is no longer presented as a strong call
    assert advice.conviction in ("low", "medium")
    assert advice.prob_higher_pct == pytest.approx(100 - advice.prob_lower_pct)


def test_prob_save_is_the_chance_of_beating_the_threshold():
    steps = _steps([100_000])                    # quantiles 80k ... 120k around a flat median
    advice = advise("Cat A", 100_000, steps, [], threshold=0.08)
    expected = qt.cdf(qt.row_values(steps[-1]), 92_000) * 100
    assert advice.prob_save_pct == pytest.approx(round(expected, 1))
    assert advice.prob_save_pct < advice.prob_lower_pct


def test_wait_conviction_uses_prob_save():
    strong = advise("Cat A", 100_000, _steps([85_000]), [], threshold=0.08)
    assert strong.action == "wait" and strong.label == "Wait" and strong.conviction == "high"
    lean = advise("Cat A", 100_000, _steps([91_900]), [], threshold=0.08)
    assert lean.action == "wait" and lean.label == "Lean wait"


def test_alert_outlook():
    steps = _steps([95_000, 90_000])
    assert alert_outlook("below", 120_000, 100_000, steps)["status"] == "triggered"
    assert alert_outlook("below", 91_000, 100_000, steps)["status"] == "likely"
    assert alert_outlook("below", 50_000, 100_000, steps)["status"] == "unlikely"


def test_alert_outlook_reports_next_and_horizon_medians():
    o = alert_outlook("below", 91_000, 100_000, _steps([95_000, 90_000]))
    assert o["next_q50"] == pytest.approx(95_000) and o["horizon_q50"] == pytest.approx(90_000)
    assert o["next_label"] == "Oct 2026 · 1st" and o["horizon_label"] == "Oct 2026 · 2nd"
