"""Small hyper-parameter sweep for the TFT (used to pick the defaults in config.py).

    docker compose run --rm --entrypoint python ml scripts/tune.py \
        '{"hidden_size": 16}' '{"hidden_size": 32, "dropout": 0.3}'

Each argument is a JSON dict of TFTConfig overrides; the special key ``_drop``
lists input features to switch off (feature ablation) and ``_cv: false`` skips
the epoch cross-validation (uses ``default_epochs``). Every configuration is
backtested on the same rolling origins against the random walk, and a pooled
leaderboard is printed at the end.

Tuning is scored on the three years *before* the held-out test period (the
test exercises are dropped first), so choosing hyper-parameters never looks at
the exercises behind the reported results.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

# this adds the ml folder to the path so that coe_ml can be imported from here
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coe_ml import evaluation, ingest                       # noqa: E402
from coe_ml.config import PipelineConfig                    # noqa: E402
from coe_ml.preparation import prepare                      # noqa: E402
from coe_ml.features import build_panel                     # noqa: E402
from coe_ml.pipeline import configure_logging               # noqa: E402


def main(overrides: list[dict], seeds: int = 3) -> None:
    configure_logging()
    panel = build_panel(ingest.load_coe_results(offline=True), ingest.load_macro(offline=True))
    # this removes the held-out test period first so that tuning never touches the exercises we
    # report on
    held_out = PipelineConfig().backtest.test_exercises
    panel = panel[panel["time_idx"] <= panel["time_idx"].max() - held_out]     # validation = the 3 years before the test period
    results = []
    for i, override in enumerate(overrides or [{}]):
        cfg = PipelineConfig()
        # this splits the special keys from the normal settings so that one JSON dict can control a
        # whole trial
        drop = override.get("_drop", [])
        cfg.backtest.select_epochs = override.get("_cv", True)
        for key, value in override.items():
            if not key.startswith("_"):
                setattr(cfg.tft, key, value)

        # this wraps prepare to blank the dropped features so that we can test a model without them
        def ablated_prepare(panel_, state, use_policy=True, _drop=drop):
            prepared = prepare(panel_, state, use_policy)
            prepared[_drop] = 0.0
            return prepared

        # this swaps in the wrapped function so that the backtest uses it without any change to its
        # code
        evaluation.prepare = ablated_prepare
        started = time.time()
        bt = evaluation.backtest(panel, cfg, n_seeds=seeds, models=["tft", "naive"])
        m = bt.metrics
        pooled = m[(m["category"] == "*") & (m["horizon"] == 0)].set_index("model")
        results.append((override, pooled, bt.best_epochs["tft"], time.time() - started))
        # this prints detail for each trial so that we can see which category or horizon moved
        by_cat = m[m["horizon"] == 0].pivot(index="category", columns="model", values="pinball").round(0)
        by_h = m[m["category"] == "*"].pivot(index="horizon", columns="model", values="pinball").round(0)
        print(f"\n{json.dumps(override)}\n-- pinball by category --\n{by_cat}\n-- pinball by horizon --\n{by_h}")

    # this prints a final table so that the trials can be compared in one view
    print("\nconfig | TFT pinball | naive pinball | TFT MAPE | cover80 | direction | epochs | seconds")
    for override, pooled, epochs, secs in results:
        t, nv = pooled.loc["tft"], pooled.loc["naive"]
        print(f"{json.dumps(override)} | {t['pinball']:.0f} | {nv['pinball']:.0f} | {t['mape']:.2f}% | "
              f"{t['coverage80']:.1f}% | {t['direction']:.1f}% | {epochs} | {secs:.0f}")


# this reads each argument as JSON so that any setting can be tried from the command line
if __name__ == "__main__":
    main([json.loads(arg) for arg in sys.argv[1:]])
