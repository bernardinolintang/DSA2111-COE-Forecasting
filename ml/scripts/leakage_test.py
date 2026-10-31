"""Leakage test: does any forecast in the backtest use data from after its origin?

    cd ml && python scripts/leakage_test.py                  # all models, ~5 min on a laptop
    cd ml && python scripts/leakage_test.py tft naive        # only some models

Runs the backtest twice with the cheap ``fast_config``: once on the real data and
once with every premium, bid count and quota after a cut-off (the middle of the
test period), and every macro value (CPI, SORA, GDP) from the cut-off month on,
multiplied by random noise. Forecasts made at origins up to the cut-off must be
bit-identical in both runs. As a control, forecasts after the cut-off must
change, which shows the test would catch a model that used the data.
Exits with status 1 if any early forecast changed.

What it cannot see: a publication lag that is too short by less than a month
(e.g. using last month's CPI before its release date) only moves data *before*
the cut-off. ``tests/test_features.py::test_macro_features_respect_publication_lags``
pins those lags instead.

``notebooks/fairness_checks.ipynb`` runs the same steps one at a time.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

# this adds the ml folder to the path so that coe_ml can be imported from here
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coe_ml import evaluation, ingest                     # noqa: E402
from coe_ml.config import PipelineConfig, fast_config     # noqa: E402
from coe_ml.features import build_panel                   # noqa: E402

# these are the models to test and the columns to scramble so that the test covers everything a
# model could peek at
MODELS = ["tft", "lstm", "gbm", "arima", "arimax_boxtiao", "naive"]
SCRAMBLED_COLUMNS = ["premium", "bids_received", "bids_success", "quota"]


def load() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, PipelineConfig, int]:
    # this always uses the snapshot so that both backtests start from identical data
    """Raw COE + macro data from the snapshot, the model panel, the config and the cut-off."""
    coe, macro = ingest.load_coe_results(offline=True), ingest.load_macro(offline=True)
    panel = build_panel(coe, macro)
    cfg = fast_config()
    # this puts the cut-off in the middle of the test period so that there are forecasts on both
    # sides of it
    test_start = int(panel["time_idx"].max()) + 1 - cfg.backtest.test_exercises
    return coe, macro, panel, cfg, test_start + cfg.backtest.test_exercises // 2


def scramble_after(coe: pd.DataFrame, panel: pd.DataFrame, cut: int, seed: int = 1) -> tuple[pd.DataFrame, np.ndarray]:
    """Multiply premiums, bids and quota of every exercise after ``cut`` by random noise (x0.3 to x3)."""
    # this finds the exercises after the cut-off so that only those rows get noise
    exercises = panel.drop_duplicates("time_idx").set_index("time_idx")
    after = set(zip(exercises.loc[cut + 1:, "month"].dt.strftime("%Y-%m-%d"), exercises.loc[cut + 1:, "bidding_no"]))
    mask = np.array([(m, b) in after for m, b in zip(coe["month"].astype(str).str[:10], coe["bidding_no"])])
    scrambled = coe.copy()
    rng = np.random.default_rng(seed)
    for col in SCRAMBLED_COLUMNS:
        scrambled.loc[mask, col] = (scrambled.loc[mask, col] * rng.uniform(0.3, 3.0, mask.sum())).round()
    return scrambled, mask


def scramble_macro_after(macro: pd.DataFrame, panel: pd.DataFrame, cut: int, seed: int = 2) -> tuple[pd.DataFrame, np.ndarray]:
    """Multiply every macro value dated in the cut-off exercise's month or later by random noise.

    Nothing dated in that month can be public at its first exercise, so origins up
    to the cut-off must not depend on these values.
    """
    # this finds the cut-off month so that only macro values from then on get noise
    cut_month = panel.loc[panel["time_idx"] == cut, "month"].iloc[0]
    mask = (pd.to_datetime(macro["month"]) >= cut_month).to_numpy()
    scrambled = macro.copy()
    scrambled.loc[mask, "value"] = scrambled.loc[mask, "value"] * np.random.default_rng(seed).uniform(0.3, 3.0, mask.sum())
    return scrambled, mask


def compare(real: pd.DataFrame, fake: pd.DataFrame, cut: int) -> pd.DataFrame:
    """Join both backtests' predictions; ``max_diff`` is the largest change in p10/p50/p90 (SGD)."""
    # this pairs up each forecast from both runs so that we can see how much it moved
    both = real.merge(fake, on=["model", "category", "origin", "horizon"], suffixes=("", "_s"))
    both["max_diff"] = np.abs(both[["q10", "q50", "q90"]].to_numpy()
                              - both[["q10_s", "q50_s", "q90_s"]].to_numpy()).max(axis=1)
    both["before_cut"] = both["origin"] <= cut
    return both


def summarise(both: pd.DataFrame) -> bool:
    """Print the verdict; True when no forecast before the cut-off changed."""
    # this splits forecasts by the cut-off so that the two groups can be judged separately
    before, later = both[both["before_cut"]], both[~both["before_cut"]]
    print("Forecasts made BEFORE the cut-off (must not change):")
    print(before.groupby("model")["max_diff"].max().map(lambda v: f"max change S${v:,.6f}").to_string())
    print(f"  -> {(before['max_diff'] == 0).mean() * 100:.1f}% of {len(before)} forecasts bit-identical")
    print("\nControl: forecasts made AFTER the cut-off (must change):")
    print(f"  -> {(later['max_diff'] > 1).mean() * 100:.1f}% of {len(later)} forecasts changed by > S$1")
    # this fails on any change at all so that even a tiny leak gets caught
    passed = not (before["max_diff"] > 0).any()
    print("\nPASS: no forecast uses data from after its origin" if passed
          else "\nLEAK: a forecast changed when only later data was scrambled")
    return passed


def main(models: list[str] | None = None) -> None:
    models = models or MODELS
    # this builds both datasets so that the only difference is the data after the cut-off
    coe, macro, panel, cfg, cut = load()
    scrambled, mask = scramble_after(coe, panel, cut)
    macro_scrambled, macro_mask = scramble_macro_after(macro, panel, cut)
    print(f"Scrambled {mask.sum()} COE rows after exercise {cut} and {macro_mask.sum()} macro values from its month on")

    # this runs the backtest twice so that any early forecast that changes must have seen later data
    real = evaluation.backtest(panel, cfg, n_seeds=1, models=models).predictions
    fake = evaluation.backtest(build_panel(scrambled, macro_scrambled), cfg, n_seeds=1, models=models).predictions
    if not summarise(compare(real, fake, cut)):
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
