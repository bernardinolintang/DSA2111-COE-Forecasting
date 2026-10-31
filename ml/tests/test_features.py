"""Tests for feature engineering, the target transform and the Box-Tiao model."""

import numpy as np
import pandas as pd
import pytest

from coe_ml.config import CATEGORIES
from coe_ml.evaluation import summarise
from coe_ml.features import (TargetScaler, add_known_features, extend_with_future, macro_features,
                             next_exercises, quota_quarter)
from coe_ml.interventions import select_and_fit


# this checks the calendar rolls into the next month so that future exercises get the right dates
def test_next_exercises_rolls_over_months():
    out = next_exercises(pd.Timestamp("2026-09-01"), 2, 3)
    assert out == [(pd.Timestamp("2026-10-01"), 1), (pd.Timestamp("2026-10-01"), 2), (pd.Timestamp("2026-11-01"), 1)]


# this checks the quarter boundaries so that quota changes land on the right exercise
@pytest.mark.parametrize("month,expected", [
    ("2026-02-01", (2026, 0)), ("2026-04-01", (2026, 0)), ("2026-05-01", (2026, 1)),
    ("2026-10-01", (2026, 2)), ("2026-11-01", (2026, 3)), ("2027-01-01", (2026, 3)),
])
def test_quota_quarters_start_in_feb_may_aug_nov(month, expected):
    assert quota_quarter(pd.Timestamp(month)) == expected


# this builds a small fake history so that the tests do not need the real data
def _history(last_month="2026-09-01", quota=1000):
    rows = []
    months = pd.date_range(end=last_month, periods=12, freq="MS")
    t = 0
    for m in months:
        for b in (1, 2):
            for c in CATEGORIES:
                rows.append({"category": c, "time_idx": t, "month": m, "bidding_no": b, "quota": quota,
                             "premium": 100_000.0})
            t += 1
    return add_known_features(pd.DataFrame(rows))


# this checks scenarios only touch unannounced quarters so that a what-if cannot change a public
# quota
def test_future_quota_is_announced_then_scenario():
    """Sep #2 -> Oct (same Aug-Oct quarter, quota known) then Nov (scenario applies)."""
    ext = extend_with_future(_history(), horizon=4, quota_multiplier=1.2)
    fut = ext[ext["is_future"] & (ext["category"] == "A")].sort_values("time_idx")
    assert fut["quota"].tolist() == [1000, 1000, 1200, 1200]
    assert fut["pos_in_quarter"].tolist() == [0.8, 1.0, 0.0, 0.2]


# this checks policy dummies stay inside their categories so that one policy does not leak into
# others
def test_policy_dummies_only_hit_affected_categories():
    ext = extend_with_future(_history("2025-06-01"), horizon=2)
    row = ext[(ext["month"] == "2025-06-01") & (ext["bidding_no"] == 1)].set_index("category")
    assert row.loc["A", "pol_ev_reclassification_2022"] == 1.0
    assert row.loc["D", "pol_ev_reclassification_2022"] == 0.0
    assert (row["pol_quota_injection_2025"] == 1.0).all()


# this pins the release delays so that the model cannot use numbers before they were public
def test_macro_features_respect_publication_lags():
    """At a bidding month m the model may only use CPI of m-2 (released ~23rd of m-1),
    SORA of m-1 and GDP of a quarter that ended at least two months earlier."""
    months = pd.date_range("2020-01-01", periods=36, freq="MS")
    k = np.arange(len(months), dtype=float)
    macro = pd.concat([
        pd.DataFrame({"month": months, "indicator": "cpi_all_items", "value": 100.0 + k}),
        pd.DataFrame({"month": months, "indicator": "sora_3m", "value": k}),
        pd.DataFrame({"month": months[2::3], "indicator": "gdp_real", "value": 1000.0 + k[2::3]}),
    ])
    out = macro_features(macro).set_index("month")
    june = pd.Timestamp("2022-06-01")
    i = months.get_loc(june)
    assert out.loc[june, "cpi_yoy"] == pytest.approx(((100 + i - 2) / (100 + i - 14) - 1) * 100)
    assert out.loc[june, "sora_3m"] == i - 1
    q1, q4 = months.get_loc(pd.Timestamp("2022-03-01")), months.get_loc(pd.Timestamp("2021-12-01"))
    assert out.loc[june, "gdp_yoy"] == pytest.approx(((1000 + q1) / (1000 + q1 - 12) - 1) * 100)
    assert out.loc[pd.Timestamp("2022-04-01"), "gdp_yoy"] == pytest.approx(((1000 + q4) / (1000 + q4 - 12) - 1) * 100)


# this checks the transform can be undone so that forecasts convert back to the right dollars
def test_target_scaler_round_trip():
    df = pd.DataFrame({"category": "A", "premium": np.linspace(2_000, 150_000, 50)})
    scaler = TargetScaler().fit(df)
    scaled = scaler.transform("A", df["premium"])
    assert scaled.min() == pytest.approx(0) and scaled.max() == pytest.approx(1)
    assert np.allclose(scaler.inverse("A", scaled), df["premium"], rtol=1e-6)


# this fakes a known jump in the data so that we can see if Box-Tiao finds the right size
def test_box_tiao_recovers_a_known_level_shift():
    rng = np.random.default_rng(1)
    n, onset, shift = 300, 180, 2.0
    step = (np.arange(n) >= onset).astype(float)
    y = np.cumsum(rng.normal(0, 0.3, n)) + shift * step
    _, res = select_and_fit(y, step[:, None])
    assert abs(res.params[0] - shift) < 3 * res.bse[0]


# this checks the metrics by hand on two rows so that the scoring maths is correct
def test_metrics_summary():
    df = pd.DataFrame({"actual": [100.0, 200.0], "q10": [90.0, 150.0], "q50": [110.0, 190.0],
                       "q90": [120.0, 195.0], "origin_premium": [105.0, 180.0]})
    m = summarise(df)
    assert m["mae"] == pytest.approx(10.0)
    assert m["coverage80"] == pytest.approx(50.0)
    assert m["direction"] == pytest.approx(50.0)
