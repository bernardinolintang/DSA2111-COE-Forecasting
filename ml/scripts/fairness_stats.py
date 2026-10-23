"""Is the backtest score fair? Statistics from a stored run's backtest predictions.

    docker compose run --rm -v ./ml/scripts:/app/scripts --entrypoint python ml \
        scripts/fairness_stats.py [run_id]          # default: latest succeeded run

Reports, for every model in the run:
  0. integrity  – the random walk's median equals the premium at the origin
  1. pooled pinball / MAE / MAPE and skill vs the random walk
  2. 95% moving-block bootstrap CI of that skill (blocks of 6 consecutive origins,
     because forecasts from neighbouring origins overlap)
  3. skill per test year (is the gain stable?)
  4. calibration: share of actuals below p10 / p50, above p90 and inside [p10, p90]
  5. MAPE by horizon of the hybrid (or the best model) (genuine forecasts get worse further ahead)

``report(df)`` works on any predictions table, e.g. ``evaluation.backtest(...).predictions``
plus an ``origin_premium`` column; ``notebooks/fairness_checks.ipynb`` shows how.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coe_ml import db                                     # noqa: E402

BLOCK, N_BOOT = 6, 5000

# Same exercise counter as features.build_panel: only exercises where all five categories were auctioned.
QUERY = """
WITH exercises AS (
    SELECT month, bidding_no, row_number() OVER (ORDER BY month, bidding_no) - 1 AS time_idx
    FROM coe_results GROUP BY month, bidding_no HAVING count(DISTINCT category) = 5
)
SELECT p.*, r.premium AS origin_premium
FROM backtest_predictions p
JOIN exercises e ON e.time_idx = p.origin
JOIN coe_results r ON r.month = e.month AND r.bidding_no = e.bidding_no AND r.category = p.category
WHERE p.run_id = :run_id
"""


def pinball(df: pd.DataFrame) -> np.ndarray:
    y = df["actual"]
    return np.mean([np.maximum(tau * (y - df[c]), (tau - 1) * (y - df[c]))
                    for c, tau in (("q10", 0.1), ("q50", 0.5), ("q90", 0.9))], axis=0)


def block_indices(n: int, rng: np.random.Generator) -> list[np.ndarray]:
    starts = np.arange(n - BLOCK + 1)
    n_blocks = int(np.ceil(n / BLOCK))
    return [np.concatenate([np.arange(s, s + BLOCK) for s in rng.choice(starts, n_blocks)])[:n]
            for _ in range(N_BOOT)]


def load_predictions(run_id: int | None = None) -> tuple[int, pd.DataFrame]:
    """Backtest predictions of ``run_id`` (default: latest succeeded run) with the origin premium."""
    engine = db.get_engine()
    with engine.connect() as conn:
        if run_id is None:
            run_id = conn.execute(text("SELECT max(id) FROM model_runs WHERE status = 'succeeded'")).scalar()
        df = pd.read_sql(text(QUERY), conn, params={"run_id": run_id}, parse_dates=["month"])
    if df.empty:
        sys.exit(f"run {run_id} has no backtest predictions")
    return run_id, df


def report(df: pd.DataFrame) -> None:
    """Print statistics 0-5 for a predictions table (columns as in ``backtest_predictions`` + origin_premium)."""
    if "naive" not in set(df["model"]):
        raise ValueError("the predictions need the random walk ('naive') as the benchmark")
    df = df.copy()
    df["loss"] = pinball(df)
    rng = np.random.default_rng(0)

    naive = df[df["model"] == "naive"]
    same = np.isclose(naive["q50"], naive["origin_premium"], rtol=1e-6).mean() * 100
    print(f"{len(df)} predictions, {df['origin'].nunique()} origins, "
          f"{df['month'].min():%b %Y} - {df['month'].max():%b %Y}")
    print(f"\n0. Integrity: random-walk median == origin premium in {same:.1f}% of rows")

    err = (df["q50"] - df["actual"]).abs()
    pooled = pd.DataFrame({
        "pinball": df.groupby("model")["loss"].mean(),
        "mae": err.groupby(df["model"]).mean(),
        "mape": (err / df["actual"] * 100).groupby(df["model"]).mean(),
    })
    pooled["skill_vs_rw_%"] = (1 - pooled["pinball"] / pooled.loc["naive", "pinball"]) * 100
    print("\n1. Pooled scores\n", pooled.sort_values("pinball").round(2))

    per_origin = df.pivot_table(index="origin", columns="model", values="loss", aggfunc="mean")
    idx = block_indices(len(per_origin), rng)
    print("\n2. Skill vs random walk, 95% block-bootstrap CI (positive = better than random walk)")
    rw = per_origin["naive"].to_numpy()
    for model in per_origin.columns.drop("naive"):
        loss = per_origin[model].to_numpy()
        boots = np.array([(1 - loss[i].mean() / rw[i].mean()) * 100 for i in idx])
        lo, hi = np.percentile(boots, [2.5, 97.5])
        print(f"   {model:15s} {(1 - loss.mean() / rw.mean()) * 100:+6.2f}%  CI [{lo:+6.2f}%, {hi:+6.2f}%]  "
              f"P(better)={np.mean(boots > 0):.2f}")

    df["year"] = pd.cut(df["origin"], 3, labels=["year 1", "year 2", "year 3"])
    by_year = df.pivot_table(index="year", columns="model", values="loss", aggfunc="mean", observed=True)
    skill = (1 - by_year.drop(columns="naive").div(by_year["naive"], axis=0)) * 100
    print("\n3. Skill vs random walk by test year (%)\n", skill.round(2))

    print("\n4. Calibration (ideal: 10% below p10, 50% below p50, 10% above p90, 80% inside)")
    for model in [m for m in ("hybrid", "tft", "arima", "naive") if m in set(df["model"])] or sorted(set(df["model"])):
        d = df[df["model"] == model]
        below10, below50, above90 = d["actual"] < d["q10"], d["actual"] < d["q50"], d["actual"] > d["q90"]
        inside = (~below10 & ~above90).groupby(d["origin"]).mean().to_numpy()
        lo, hi = np.percentile([inside[i].mean() * 100 for i in idx], [2.5, 97.5])
        print(f"   {model:8s} below p10 {below10.mean() * 100:5.1f}%  below p50 {below50.mean() * 100:5.1f}%  "
              f"above p90 {above90.mean() * 100:5.1f}%  inside 80% {inside.mean() * 100:5.1f}% "
              f"(CI {lo:.1f}-{hi:.1f})")

    best = pooled.drop(index="naive")["pinball"].idxmin() if len(pooled) > 1 else "naive"
    d = df[df["model"] == ("hybrid" if "hybrid" in pooled.index else best)]
    by_h = ((d["q50"] - d["actual"]).abs() / d["actual"] * 100).groupby(d["horizon"]).mean()
    print(f"\n5. {d['model'].iloc[0]} MAPE by horizon (%):", by_h.round(2).to_dict())


def main(run_id: int | None = None) -> None:
    run_id, df = load_predictions(run_id)
    print(f"Run {run_id}")
    report(df)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else None)
