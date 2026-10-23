"""Unit tests for the pure decision-support logic (no database needed)."""

from datetime import date

import pytest

from app.services import quantiles as qt
from app.services import scenarios as sc
from app.services.recommendation import advise, alert_outlook, outlook_for, uncertainty_for

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


def test_downward_pressure_when_the_odds_lean_clearly_lower():
    advice = advise("Cat A", 100_000, _steps([98_000, 95_000, 90_000]), [], threshold=0.08)
    assert (advice.outlook, advice.label) == ("easing", "Downward pressure")
    assert (advice.direction, advice.strength) == ("down", "strong")
    assert advice.expected_change_pct == pytest.approx(-10.0)
    assert advice.prob_lower_pct >= 65 and advice.meaningful_drop is True
    assert "more likely to fall than rise" in advice.summary


def test_slight_downward_pressure_when_the_drop_is_small():
    advice = advise("Cat A", 100_000, _steps([99_000, 97_000, 96_000]), [], threshold=0.08)
    # the median is 4% lower: a fall is more likely than a rise, but it is not a clear call
    assert (advice.outlook, advice.label) == ("softer", "Slight downward pressure")
    assert advice.strength == "slight" and advice.meaningful_drop is False
    assert 55 <= advice.prob_lower_pct < 65
    assert "Slight downward pressure on Cat A" in advice.summary


def test_upward_pressure_when_prices_rise():
    advice = advise("Cat B", 100_000, _steps([103_000, 106_000, 110_000]), [], threshold=0.08)
    assert (advice.outlook, advice.label) == ("rising", "Upward pressure")
    assert advice.direction == "up" and advice.prob_higher_pct >= 65


def test_flat_forecast_shows_no_clear_direction():
    """The case from the demo: median ~1% above today with wide ranges."""
    advice = advise("Cat A", 131_890, _steps([133_000, 133_300]), [], threshold=0.08)
    assert (advice.outlook, advice.label) == ("steady", "No clear direction")
    assert (advice.direction, advice.strength) == ("flat", "none")
    assert advice.prob_higher_pct == pytest.approx(100 - advice.prob_lower_pct)
    assert "a fall is about as likely as a rise" in advice.summary


def test_the_outlook_never_tells_anyone_to_buy_or_wait():
    for path in ([85_000], [96_000], [100_000], [104_000], [115_000]):
        advice = advise("Cat A", 100_000, _steps(path), [], threshold=0.08)
        text = " ".join([advice.label, advice.summary, *advice.reasons]).lower()
        assert "buy" not in text and "wait" not in text


def test_prob_drop_is_the_chance_of_a_meaningful_fall():
    steps = _steps([100_000])                    # quantiles 80k ... 120k around a flat median
    advice = advise("Cat A", 100_000, steps, [], threshold=0.08)
    expected = qt.cdf(qt.row_values(steps[-1]), 92_000) * 100
    assert advice.prob_drop_pct == pytest.approx(round(expected, 1))
    assert advice.prob_drop_pct < advice.prob_lower_pct
    assert "A drop of 8% or more has a 25% chance" in advice.summary


def test_uncertainty_levels_and_next_exercise():
    assert [uncertainty_for(w) for w in (5, 12, 20)] == ["low", "moderate", "high"]
    assert [outlook_for(p) for p in (0.7, 0.6, 0.5, 0.4, 0.3)] == ["easing", "softer", "steady", "firmer", "rising"]
    advice = advise("Cat A", 100_000, _steps([101_000, 100_000]), [], threshold=0.08)
    assert advice.next_label == "Oct 2026 · 1st" and advice.next_q50 == pytest.approx(101_000)
    assert advice.uncertainty_pct == pytest.approx(15.0) and advice.drivers[-1]["key"] == "uncertainty"


def test_drivers_compare_demand_and_quota_with_a_year_ago():
    history = [{"bids_received": 1500, "quota": 1000} for _ in range(23)] + [{"bids_received": 1100, "quota": 1100}]
    advice = advise("Cat A", 100_000, _steps([100_000]), history, threshold=0.08)
    demand, quota, uncertainty = advice.drivers
    assert (demand["key"], demand["trend"]) == ("demand", "down") and demand["value"] == pytest.approx(1.0)
    assert (quota["key"], quota["trend"]) == ("quota", "up") and quota["value"] == pytest.approx(10.0)
    assert advice.reasons[1] == "Supply: quota is 1,100 per exercise, +10% versus a year ago."


def test_scenario_steps_interpolate_between_modelled_runs():
    runs = {"base": _steps([100_000, 100_000]), "quota_plus_10": _steps([100_000, 98_000]),
            "quota_plus_20": _steps([100_000, 96_000])}
    for rows in runs.values():
        for r in rows:
            r["quota"] = 1000
    runs["quota_plus_10"][1]["quota"], runs["quota_plus_20"][1]["quota"] = 1100, 1200
    load = runs.__getitem__
    assert sc.steps_for(None, 1, "A", 10, load=load) is runs["quota_plus_10"]        # a modelled point
    mid = sc.steps_for(None, 1, "A", 15, load=load)[1]
    assert mid["q50"] == pytest.approx(97_000) and mid["quota"] == 1150
    assert sc.steps_for(None, 1, "A", 99, load=load) is runs["quota_plus_20"]        # clamped, never extrapolated
    assert (sc.label(0), sc.label(15), sc.label(-5)) == ("As announced", "+15% supply", "−5% supply")
    assert sc.scenario_id(15) is None and sc.scenario_id(-20) == "quota_minus_20"


def test_alert_outlook():
    steps = _steps([95_000, 90_000])
    assert alert_outlook("below", 120_000, 100_000, steps)["status"] == "triggered"
    assert alert_outlook("below", 91_000, 100_000, steps)["status"] == "likely"
    assert alert_outlook("below", 50_000, 100_000, steps)["status"] == "unlikely"


def test_alert_outlook_reports_next_and_horizon_medians():
    o = alert_outlook("below", 91_000, 100_000, _steps([95_000, 90_000]))
    assert o["next_q50"] == pytest.approx(95_000) and o["horizon_q50"] == pytest.approx(90_000)
    assert o["next_label"] == "Oct 2026 · 1st" and o["horizon_label"] == "Oct 2026 · 2nd"
