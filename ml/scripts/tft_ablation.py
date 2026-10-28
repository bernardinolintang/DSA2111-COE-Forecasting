"""
TFT ablation: TFT with policy inputs vs the same TFT without.

Run from the project folder:
  docker compose run --rm -v "$PWD":/workspace -w /workspace --entrypoint python ml \
      ml/scripts/tft_ablation.py --epochs 3 --out report/data/policy_ablation/tft_fixed3

Options:
  --epochs N   give BOTH models exactly N training epochs (skips the per-model
               cross-validation epoch choice, so the only difference is the policy inputs)
  --seeds N    ensemble size (default 3)
  --workers N  parallel worker processes
  --live       download fresh data (default: committed snapshot)
  --out DIR    where to save the results

Saves predictions.csv, metrics.csv, comparison_by_category_horizon.csv, run_info.json.
change_pct = (with - without) / without * 100.  NEGATIVE = policy helped.

NOTE: TFT results change between runs and machines. Without --epochs it takes about
15-25 minutes. Run it several times with different --out folders and compare.
"""

import argparse, dataclasses, json, os, sys
from pathlib import Path

if os.path.isdir("/app"):
    sys.path.insert(0, "/app")

from coe_ml import ingest
from coe_ml.config import PipelineConfig
from coe_ml.features import build_panel
from coe_ml.evaluation import backtest

WITH, WITHOUT = "tft", "tft_no_policy"
COLS = ["pinball", "mae", "mape", "direction", "coverage80"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="download fresh data (default: committed snapshot)")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--out", default="report/data/policy_ablation/fresh")
    ap.add_argument("--epochs", type=int, default=None,
                    help="force the same epoch count for both models (skips CV epoch selection)")
    a = ap.parse_args()

    panel = build_panel(ingest.load_coe_results(offline=not a.live),
                        ingest.load_macro(offline=not a.live))
    print(f"Panel rows: {len(panel)}  Latest month: {panel['month'].max()}")

    cfg = PipelineConfig()
    if a.epochs:
        cfg = dataclasses.replace(
            cfg,
            tft=dataclasses.replace(cfg.tft, default_epochs=a.epochs),
            backtest=dataclasses.replace(cfg.backtest, select_epochs=False))
    if a.workers:
        cfg = dataclasses.replace(cfg, n_workers=a.workers)

    result = backtest(panel, cfg, n_seeds=a.seeds, models=[WITH, WITHOUT])
    print("Epochs used:", result.best_epochs,
          "(forced)" if a.epochs else "(chosen by cross-validation)")
    if a.epochs and set(result.best_epochs.values()) != {a.epochs}:
        print(f"WARNING: expected both models to use {a.epochs} epochs. "
              "The --epochs option may not have taken effect.")

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    result.predictions.to_csv(out / "predictions.csv", index=False)
    result.metrics.to_csv(out / "metrics.csv", index=False)
    json.dump({"offline": not a.live, "seeds": a.seeds, "workers": cfg.n_workers,
               "epochs_forced": a.epochs, "epochs": result.best_epochs,
               "data_through": str(panel["month"].max())},
              open(out / "run_info.json", "w"), indent=2, default=str)

    m = result.metrics
    a_ = m[m["model"] == WITH].set_index(["category", "horizon"])[COLS].add_suffix("_with_policy")
    b_ = m[m["model"] == WITHOUT].set_index(["category", "horizon"])[COLS].add_suffix("_without_policy")
    comp = a_.join(b_, how="inner").reset_index()
    for k in ["pinball", "mae", "mape"]:
        comp[f"{k}_change_pct"] = ((comp[f"{k}_with_policy"] - comp[f"{k}_without_policy"])
                                   / comp[f"{k}_without_policy"] * 100)
    comp = comp.sort_values(["category", "horizon"])
    comp.to_csv(out / "comparison_by_category_horizon.csv", index=False)

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


if __name__ == "__main__":
    main()