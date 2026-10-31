"""How predictable are COE premium changes at all?

Fits a plain linear regression of the h-step log change on simple signals
(momentum, demand pressure, quota changes) using data before the test period,
then reports out-of-sample R^2 against a zero-change random walk. A value near
zero means the market is close to a random walk, which is the bar every model
in the backtest has to clear.

    docker compose run --rm --entrypoint python ml scripts/predictability.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from sklearn.linear_model import LinearRegression

# this adds the ml folder to the path so that coe_ml can be imported from here
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coe_ml import ingest                       # noqa: E402
from coe_ml.config import BacktestConfig        # noqa: E402
from coe_ml.features import build_panel         # noqa: E402

# these are the simple signals to test so that we can see if basic momentum and demand say anything
FEATURES = ["mom1", "mom3", "mom6", "bid_ratio", "bid_ratio_chg", "quota_chg_q", "success_ratio"]


def main() -> None:
    panel = build_panel(ingest.load_coe_results(offline=True), ingest.load_macro(offline=True))
    # this builds momentum over 1, 3 and 6 exercises so that recent trends are available as signals
    panel["log_premium"] = np.log(panel["premium"])
    by_cat = panel.groupby("category")
    for lag in (1, 3, 6):
        panel[f"mom{lag}"] = by_cat["log_premium"].diff(lag)
    panel["bid_ratio_chg"] = by_cat["bid_ratio"].diff()
    test_start = panel["time_idx"].max() + 1 - BacktestConfig().test_exercises

    # this tests three horizons so that we can see if prediction gets easier further ahead
    for h in (1, 3, 6):
        # this makes the target the change h exercises ahead so that the regression predicts moves
        panel["y"] = by_cat["log_premium"].shift(-h) - panel["log_premium"]
        data = panel.dropna(subset=FEATURES + ["y"])
        # this trains on data before the test period, minus h, so that no target overlaps the test
        # period
        train = data[data["time_idx"] < test_start - h]
        test = data[data["time_idx"] >= test_start]
        model = LinearRegression().fit(train[FEATURES], train["y"])
        pred, y = model.predict(test[FEATURES]), test["y"]
        # this compares with a zero-change forecast so that R^2 near 0 means no better than a random
        # walk
        r2 = 1 - ((y - pred) ** 2).sum() / (y ** 2).sum()
        hit = (np.sign(pred) == np.sign(y))[y != 0].mean()
        print(f"h={h}: out-of-sample R^2 vs random walk {r2:+.3f}, direction {hit:.1%}")
        # this prints train and test correlations so that we can spot signals that stop working
        for f in FEATURES:
            print(f"    corr({f:14s}, change) train {train[f].corr(train['y']):+.2f}   test {test[f].corr(test['y']):+.2f}")


if __name__ == "__main__":
    main()
