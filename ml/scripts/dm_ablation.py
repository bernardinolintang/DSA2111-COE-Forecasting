"""
Direct Diebold-Mariano test: does the 'with policy' model beat the 'without policy' one?

Usage (from the project folder, inside the ml container):
  python ml/scripts/dm_ablation.py <predictions.csv> <without_model> <with_model> <output.csv>
  e.g.  ... predictions.csv tft_no_policy tft out.csv
        ... predictions.csv arima arimax_boxtiao out.csv
        
Needs columns: model, category, origin, horizon, actual, q10, q50, q90.
mean_diff = loss(with) - loss(without), in % of the premium. NEGATIVE = 'with' is better.
Verdict: p < 0.05 means a real difference, otherwise 'similar'.

For category x horizon cells the Holm-corrected p is used.
"""

import sys
import numpy as np
import pandas as pd
from scipy import stats

# these columns must exist so that a wrong file stops early
NEEDED = {"model", "category", "origin", "horizon", "actual", "q10", "q50", "q90"}


# this is the pinball loss so that the range is scored along with the median
def pinball(y, q, tau):
    return np.maximum(tau * (y - q), (tau - 1) * (y - q))


def dm_test(d, max_lag=5):
    """Two-sided DM test on per-origin loss differences, Newey-West variance."""
    d = np.asarray(d, float)
    n = len(d)
    if n < 3:
        return np.nan, np.nan
    # this adds autocovariance terms with Newey-West weights so that overlapping forecasts do not
    # overstate significance
    c = d - d.mean()
    var = c @ c / n
    for lag in range(1, min(max_lag, n - 1) + 1):
        var += 2 * (1 - lag / (max_lag + 1)) * (c[lag:] @ c[:-lag] / n)
    if var <= 0:
        return np.nan, np.nan
    s = d.mean() / np.sqrt(var / n)
    return s, 2 * stats.norm.sf(abs(s))


def main():
    # this prints the usage when the arguments are wrong so that the script explains itself
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    path, without, with_, out_path = sys.argv[1:5]
    df = pd.read_csv(path)
    # this checks the columns and model names so that bad input stops with a clear message
    if NEEDED - set(df.columns):
        sys.exit(f"Predictions file is missing columns: {sorted(NEEDED - set(df.columns))}")
    for mdl in (without, with_):
        if mdl not in set(df["model"]):
            sys.exit(f"Model '{mdl}' not in file. Found: {sorted(df['model'].unique())}")
    df = df[df["model"].isin([without, with_])].copy()

    # this averages pinball over three quantiles as a percent of premium so that every category
    # counts equally
    y = df["actual"].to_numpy()
    df["loss_pct"] = np.mean(
        [pinball(y, df[c].to_numpy(), t) for c, t in [("q10", .1), ("q50", .5), ("q90", .9)]],
        axis=0) / y * 100

    # this lines up both models on the same forecast cases so that the difference is like for like
    keys = ["category", "origin", "horizon"]
    if df.duplicated(keys + ["model"]).any():
        sys.exit("Duplicate forecast cases found. Is the file from more than one run?")
    wide = df.pivot(index=keys, columns="model", values="loss_pct").reset_index()
    if wide[[with_, without]].isna().any().any():
        sys.exit("The two models do not have identical forecast cases.")
    wide["difference"] = wide[with_] - wide[without]

    rows = []

    # this averages the gap per origin then runs the test so that each scope gives one row of
    # results
    def add(scope, cat, hor, g):
        d = g.groupby("origin")["difference"].mean().sort_index().to_numpy()
        s, p = dm_test(d)
        rows.append(dict(scope=scope, category=cat, horizon=hor, n_origins=len(d),
                         mean_diff=d.mean(), dm_stat=s, p_value=p))

    # this tests overall, per category, per horizon and per cell so that we see where policy matters
    add("ALL", "*", 0, wide)
    for cat, g in wide.groupby("category"):
        add("category", cat, 0, g)
    for h, g in wide.groupby("horizon"):
        add("horizon", "*", h, g)
    for (cat, h), g in wide.groupby(["category", "horizon"]):
        add("cell", cat, h, g)
    r = pd.DataFrame(rows)

    # this applies the Holm correction over the category x horizon cells only so that testing many
    # cells does not create false wins
    cells = r[(r.scope == "cell") & r.p_value.notna()]
    order = cells["p_value"].sort_values().index
    m = len(order)
    adj = np.minimum(np.maximum.accumulate(
        [(m - i) * r.loc[k, "p_value"] for i, k in enumerate(order)]), 1)
    r["p_holm"] = np.nan
    r.loc[order, "p_holm"] = adj

    # this turns each p value into a verdict so that the table can be read quickly
    p_use = np.where(r.scope == "cell", r.p_holm, r.p_value)
    r["verdict"] = np.where(np.isnan(p_use), "n/a",
                    np.where(p_use >= 0.05, "similar",
                    np.where(r.mean_diff < 0, "with-policy BETTER", "with-policy WORSE")))
    r.to_csv(out_path, index=False)

    # this prints the table and a count so that the result shows up right in the terminal
    pd.set_option("display.width", 200)
    print(r.round(4).to_string(index=False))
    c = r[r.scope == "cell"]
    print(f"\n{len(c)} cells | raw p<0.05: {(c.p_value < .05).sum()} | "
          f"after Holm: {(c.p_holm < .05).sum()} | "
          f"cells where 'with' had lower loss: {(c.mean_diff < 0).sum()}")


if __name__ == "__main__":
    main()