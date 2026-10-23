"""Leakage test: does any forecast in the backtest use data from after its origin?

    cd ml && python scripts/leakage_test.py          # ~5 min on a laptop, uses the data snapshot

Runs the backtest twice with the cheap ``fast_config``: once on the real data and
once with every premium and bid count after a cut-off (the middle of the test
period) multiplied by random noise. Forecasts made at origins up to the cut-off
must be bit-identical in both runs. As a control, forecasts after the cut-off
must change, which shows the test would catch a model that used the data.
Exits with status 1 if any early forecast changed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coe_ml import evaluation, ingest                     # noqa: E402
from coe_ml.config import fast_config                     # noqa: E402
from coe_ml.features import build_panel                   # noqa: E402

MODELS = ["tft", "lstm", "gbm", "arima", "arimax_boxtiao", "naive"]


def main() -> None:
    coe, macro = ingest.load_coe_results(offline=True), ingest.load_macro(offline=True)
    panel = build_panel(coe, macro)
    cfg = fast_config()
    n = int(panel["time_idx"].max()) + 1
    test_start = n - cfg.backtest.test_exercises
    cut = test_start + cfg.backtest.test_exercises // 2

    # Scramble premiums and bids of every exercise after the cut-off.
    exercises = panel.drop_duplicates("time_idx").set_index("time_idx")
    after = set(zip(exercises.loc[cut + 1:, "month"].dt.strftime("%Y-%m-%d"), exercises.loc[cut + 1:, "bidding_no"]))
    mask = np.array([(m, b) in after for m, b in zip(coe["month"].astype(str).str[:10], coe["bidding_no"])])
    scrambled = coe.copy()
    rng = np.random.default_rng(1)
    for col in ["premium", "bids_received", "bids_success"]:
        scrambled.loc[mask, col] = (scrambled.loc[mask, col] * rng.uniform(0.3, 3.0, mask.sum())).round()
    print(f"Scrambled {mask.sum()} rows after exercise {cut} (test period {test_start}..{n - 1})")

    real = evaluation.backtest(panel, cfg, n_seeds=1, models=MODELS).predictions
    fake = evaluation.backtest(build_panel(scrambled, macro), cfg, n_seeds=1, models=MODELS).predictions

    both = real.merge(fake, on=["model", "category", "origin", "horizon"], suffixes=("", "_s"))
    both["max_diff"] = np.abs(both[["q10", "q50", "q90"]].to_numpy()
                              - both[["q10_s", "q50_s", "q90_s"]].to_numpy()).max(axis=1)
    before, later = both[both["origin"] <= cut], both[both["origin"] > cut]

    print("\nForecasts made BEFORE the cut-off (must not change):")
    print(before.groupby("model")["max_diff"].max().map(lambda v: f"max change S${v:,.6f}").to_string())
    print(f"  -> {(before['max_diff'] == 0).mean() * 100:.1f}% of {len(before)} forecasts bit-identical")
    print("\nControl: forecasts made AFTER the cut-off (must change):")
    print(f"  -> {(later['max_diff'] > 1).mean() * 100:.1f}% of {len(later)} forecasts changed by > S$1")

    if (before["max_diff"] > 0).any():
        sys.exit("LEAK: a forecast changed when only later data was scrambled")
    print("\nPASS: no forecast uses data from after its origin")


if __name__ == "__main__":
    main()
