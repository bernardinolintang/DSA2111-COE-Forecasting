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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coe_ml import ingest                       # noqa: E402
from coe_ml.config import BacktestConfig        # noqa: E402
from coe_ml.features import build_panel         # noqa: E402

FEATURES = ["mom1", "mom3", "mom6", "bid_ratio", "bid_ratio_chg", "quota_chg_q", "success_ratio"]


def main() -> None:
    panel = build_panel(ingest.load_coe_results(offline=True), ingest.load_macro(offline=True))
    panel["log_premium"] = np.log(panel["premium"])
    by_cat = panel.groupby("category")
    for lag in (1, 3, 6):
        panel[f"mom{lag}"] = by_cat["log_premium"].diff(lag)
    panel["bid_ratio_chg"] = by_cat["bid_ratio"].diff()
    test_start = panel["time_idx"].max() + 1 - BacktestConfig().test_exercises

    for h in (1, 3, 6):
        panel["y"] = by_cat["log_premium"].shift(-h) - panel["log_premium"]
        data = panel.dropna(subset=FEATURES + ["y"])
        train = data[data["time_idx"] < test_start - h]
        test = data[data["time_idx"] >= test_start]
        model = LinearRegression().fit(train[FEATURES], train["y"])
        pred, y = model.predict(test[FEATURES]), test["y"]
        r2 = 1 - ((y - pred) ** 2).sum() / (y ** 2).sum()
        hit = (np.sign(pred) == np.sign(y))[y != 0].mean()
        print(f"h={h}: out-of-sample R^2 vs random walk {r2:+.3f}, direction {hit:.1%}")
        for f in FEATURES:
            print(f"    corr({f:14s}, change) train {train[f].corr(train['y']):+.2f}   test {test[f].corr(test['y']):+.2f}")


if __name__ == "__main__":
    main()
