"""
ARIMA vs ARIMAX + Box-Tiao (policy dummies added).

Run from the project folder:
  docker compose run --rm -v "$PWD":/workspace -w /workspace --entrypoint python ml \
      ml/scripts/arima_ablation.py --out report/data/policy_ablation/arima_run1

Saves predictions.csv, metrics.csv, comparison_by_category_horizon.csv, run_info.json.
change_pct = (with - without) / without * 100.  NEGATIVE = policy helped.

Here 'with policy' = arimax_boxtiao, 'without policy' = arima.
ARIMA has no randomness, so repeated runs give identical numbers.
"""

import argparse, json, os, sys
from pathlib import Path

# this adds the image's code folder when running in docker so that coe_ml can be imported
if os.path.isdir("/app"):
    sys.path.insert(0, "/app")

from coe_ml import ingest
from coe_ml.config import PipelineConfig
from coe_ml.features import build_panel
from coe_ml.evaluation import backtest

# these are the two models and the columns to compare so that the script only reports what the
# ablation needs
WITH, WITHOUT = "arimax_boxtiao", "arima"
COLS = ["pinball", "mae", "mape", "direction", "coverage80"]


def main():
    # these options are there so that the run can be repeated with other seeds, workers or output
    # folders
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="download fresh data (default: committed snapshot)")
    ap.add_argument("--seeds", type=int, default=1)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--out", default="report/data/fresh_arima_boxtiao")
    a = ap.parse_args()

    # this builds the panel from the snapshot unless --live is set so that reruns use the same data
    panel = build_panel(ingest.load_coe_results(offline=not a.live),
                        ingest.load_macro(offline=not a.live))
    print(f"Panel rows: {len(panel)}  Latest month: {panel['month'].max()}")
    cfg = PipelineConfig()
    if a.workers:
        cfg.n_workers = a.workers

    # this backtests only the two models so that the run stays short
    result = backtest(panel, cfg, n_seeds=a.seeds, models=[WITH, WITHOUT])

    # this saves the raw outputs so that the results can be checked later or fed into dm_ablation.py
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    result.predictions.to_csv(out / "predictions.csv", index=False)
    result.metrics.to_csv(out / "metrics.csv", index=False)
    json.dump({"offline": not a.live, "seeds": a.seeds, "workers": cfg.n_workers,
               "data_through": str(panel["month"].max())},
              open(out / "run_info.json", "w"), indent=2, default=str)

    # both models must be scored on exactly the same forecasts, this checks that so that the
    # comparison is fair
    p = result.predictions
    keys = ["category", "origin", "horizon"]
    x = p[p["model"] == WITHOUT][keys + ["actual"]]
    y = p[p["model"] == WITH][keys + ["actual"]]
    both = x.merge(y, on=keys, how="outer", suffixes=("_a", "_x"), indicator=True, validate="one_to_one")
    print(f"ARIMA: {len(x)}  ARIMAX: {len(y)}  unmatched: {(both['_merge'] != 'both').sum()}")
    if not (both["_merge"] == "both").all():
        raise RuntimeError("The models do not have identical forecast cases.")
    if not (both["actual_a"].to_numpy() == both["actual_x"].to_numpy()).all():
        raise RuntimeError("Actual values differ between the models.")

    # this puts both models side by side so that we can work out the percent change from adding
    # policy
    m = result.metrics
    a_ = m[m["model"] == WITH].set_index(["category", "horizon"])[COLS].add_suffix("_with_policy")
    b_ = m[m["model"] == WITHOUT].set_index(["category", "horizon"])[COLS].add_suffix("_without_policy")
    comp = a_.join(b_, how="inner").reset_index()
    for k in ["pinball", "mae", "mape"]:
        comp[f"{k}_change_pct"] = ((comp[f"{k}_with_policy"] - comp[f"{k}_without_policy"])
                                   / comp[f"{k}_without_policy"] * 100)
    comp = comp.sort_values(["category", "horizon"])
    comp.to_csv(out / "comparison_by_category_horizon.csv", index=False)

    # this prints the results from overall down to each cell so that we can see where policy helped
    show = ["category", "horizon", "pinball_with_policy", "pinball_without_policy", "pinball_change_pct"]
    print("\n=== OVERALL (category *, horizon 0) ===")
    print(comp[(comp.category == "*") & (comp.horizon == 0)][show].to_string(index=False))
    print("\n=== BY CATEGORY (all steps pooled) ===")
    print(comp[(comp.category != "*") & (comp.horizon == 0)][show].to_string(index=False))
    print("\n=== BY STEP AHEAD (all categories pooled) ===")
    print(comp[(comp.category == "*") & (comp.horizon > 0)][show].to_string(index=False))
    print("\n=== BY CATEGORY AND STEP (negative change = policy helped) ===")
    print(comp[(comp.category != "*") & (comp.horizon > 0)][show].to_string(index=False))
    print(f"\nSaved in: {out}")


# this runs main only when called directly so that spawned workers can import this file safely
if __name__ == "__main__":
    main()