"""Rolling-origin backtest of the TFT against every baseline.

Timeline (exercise indices, oldest -> newest)::

    |--------------------- fit ---------------------|------ test ------|
                        | fold 3 | fold 2 | fold 1 |                  ^ now
                                                   ^ test_start

* Transformations and Box-Tiao effects are fitted on the fit period only.
* The neural nets' epoch count is chosen by rolling time-series cross-validation
  inside the fit period: for each fold, train on everything before it and
  record the validation loss after every epoch; average the learning curves
  over folds and seeds and take the minimum. The final networks are then
  trained on the whole fit period for that many epochs.
* Forecast origins step through ``test`` every ``origin_stride`` exercises.
  At each origin a model only sees data up to that origin, and future quota
  follows the same "announced quota, then persistence" rule used in production.

Accuracy is reported in SGD for the median (MAE, RMSE, MAPE, sMAPE), for the
interval (80% coverage of [p10, p90]) and jointly (pinball loss over
p10/p50/p90), per model, category and horizon.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .baselines import ArimaForecaster, GBMForecaster, NaiveForecaster
from .config import CATEGORIES, QUANTILES, PipelineConfig
from .features import extend_with_future
from .preparation import FittedState, fit_state, prepare
from .training import Ensemble, TrainJob, Windows, make_windows, train_many

log = logging.getLogger(__name__)

MODEL_LABELS = {
    "hybrid": "Hybrid: TFT + Box-Tiao ARIMAX (ours)",
    "tft": "TFT with policy inputs",
    "tft_no_policy": "TFT without policy inputs",
    "lstm": "Seq2Seq LSTM",
    "gbm": "Gradient boosting",
    "arimax_boxtiao": "ARIMAX + Box-Tiao",
    "arima": "ARIMA",
    "naive": "Random walk",
}
Q_IDX = [QUANTILES.index(0.1), QUANTILES.index(0.5), QUANTILES.index(0.9)]


@dataclass
class BacktestResult:
    metrics: pd.DataFrame
    predictions: pd.DataFrame
    best_epochs: dict[str, int]
    cv_curves: dict[str, list[float]]
    test_start: int
    dm_tests: dict[str, dict]


# name -> (network kind, uses policy inputs)
NEURAL_SPECS = {"tft": ("tft", True), "tft_no_policy": ("tft", False), "lstm": ("lstm", True)}


def _threads(cfg: PipelineConfig) -> int:
    return max(1, (os.cpu_count() or 2) // max(1, cfg.n_workers))


def select_epochs(windows: dict[bool, Windows], test_start: int, cfg: PipelineConfig, n_seeds: int,
                  names: list[str]) -> tuple[dict[str, int], dict[str, list[float]]]:
    """Choose each network's epoch count by rolling-origin cross-validation."""
    H, fold = cfg.tft.horizon, cfg.backtest.fold_exercises
    jobs = []
    for k in range(cfg.backtest.cv_folds):
        fold_end = test_start - k * fold
        fold_start = fold_end - fold
        for name in names:
            kind, policy = NEURAL_SPECS[name]
            w = windows[policy]
            train = w.subset(w.origin + H < fold_start)
            val = w.subset((w.origin >= fold_start - 1) & (w.origin + H < fold_end))
            jobs += [(name, TrainJob(kind, train, val, cfg.tft, seed=cfg.tft.seed + s,
                                     epochs=cfg.tft.max_epochs, threads=_threads(cfg)))
                     for s in range(n_seeds)]
    results = train_many([job for _, job in jobs], cfg.n_workers)

    best, curves = {}, {}
    for name in names:
        curve = np.mean([r.val_curve for (n_, _), r in zip(jobs, results) if n_ == name], axis=0)
        best[name], curves[name] = int(np.argmin(curve)) + 1, [float(v) for v in curve]
        log.info("%s: CV picks %d epochs (val loss %.4f, epoch-1 %.4f)", name, best[name], curve.min(), curve[0])
    return best, curves


def backtest(panel: pd.DataFrame, cfg: PipelineConfig, n_seeds: int = 3,
             models: list[str] | None = None) -> BacktestResult:
    """Evaluate ``models`` (default: all in MODEL_LABELS) on the held-out test period."""
    models = list(models or MODEL_LABELS)
    L, H = cfg.tft.encoder_length, cfg.tft.horizon
    n = int(panel["time_idx"].max()) + 1
    test_start = n - cfg.backtest.test_exercises
    log.info("Backtest: fit < %d <= test < %d", test_start, n)

    fit_panel = panel[panel["time_idx"] < test_start]
    state = fit_state(fit_panel, cfg.n_workers)
    fit_prepared = {p: prepare(fit_panel, state, use_policy=p) for p in (True, False)}
    windows = {p: make_windows(fit_prepared[p], L, H) for p in (True, False)}
    log.info("Training windows: %d", len(windows[True]))

    # ---- neural networks ---------------------------------------------------
    neural = [name for name in NEURAL_SPECS if name in models]
    if neural and cfg.backtest.select_epochs:
        best_epochs, cv_curves = select_epochs(windows, test_start, cfg, n_seeds, neural)
    else:
        best_epochs, cv_curves = {name: cfg.tft.default_epochs for name in neural}, {}
    jobs = [(name, TrainJob(NEURAL_SPECS[name][0], windows[NEURAL_SPECS[name][1]], None, cfg.tft,
                            seed=cfg.tft.seed + s, epochs=best_epochs[name], threads=_threads(cfg)))
            for name in neural for s in range(n_seeds)]
    results = train_many([job for _, job in jobs], cfg.n_workers)
    ensembles = {name: Ensemble(NEURAL_SPECS[name][0], cfg.tft,
                                [r.state_dict for (n_, _), r in zip(jobs, results) if n_ == name])
                 for name in neural}

    # ---- classical baselines -------------------------------------------------
    classical = {}
    if "naive" in models:
        classical["naive"] = NaiveForecaster().fit(fit_prepared[True], H)
    if "gbm" in models:
        classical["gbm"] = GBMForecaster().fit(windows[True])
    arimas = {name: ArimaForecaster(with_interventions=(name == "arimax_boxtiao")).fit(fit_prepared[True], cfg.n_workers)
              for name in ("arima", "arimax_boxtiao") if name in models}

    # ---- roll through the test period -------------------------------------
    origins = list(range(test_start - 1, n - H, cfg.backtest.origin_stride))
    rows = []
    for t in origins:
        extended = extend_with_future(panel[panel["time_idx"] <= t], H)
        prepared = {p: prepare(extended, state, use_policy=p) for p in (True, False)}
        at_origin = {c: [t] for c in CATEGORIES}
        w = {p: make_windows(prepared[p], L, H, at_origin, require_target=False) for p in (True, False)}

        scaled = {name: ens.predict(w[NEURAL_SPECS[name][1]])["prediction"][..., Q_IDX]
                  for name, ens in ensembles.items()}
        scaled.update({name: model.predict(w[True]) for name, model in classical.items()})
        for name, model in arimas.items():
            per_cat = []
            for cat in w[True].category:
                grp = prepared[True][prepared[True]["category"] == cat].sort_values("time_idx")
                per_cat.append(model.predict_origin(cat, grp[grp["time_idx"] <= t], grp[grp["time_idx"] > t]))
            scaled[name] = np.stack(per_cat)

        rows.extend(_to_rows(scaled, w[True], panel, state, t, H))

    predictions = add_hybrid(pd.DataFrame(rows)) if "hybrid" in models else pd.DataFrame(rows)
    reference = "hybrid" if "hybrid" in set(predictions["model"]) else "tft"
    dm = diebold_mariano(predictions, model=reference, horizon_lag=H - 1) if reference in set(predictions["model"]) else {}
    return BacktestResult(compute_metrics(predictions), predictions, best_epochs, cv_curves, test_start, dm)


HYBRID_MEMBERS = ("tft", "arimax_boxtiao")


def combine_quantiles(members: list[np.ndarray]) -> np.ndarray:
    """Equal-weight quantile averaging (Vincentization) of member forecasts in SGD.

    The weights are fixed in advance rather than fitted, which avoids tuning on
    the test period; averaging quantiles of monotone forecasts stays monotone.
    """
    return np.mean(members, axis=0)


def add_hybrid(predictions: pd.DataFrame) -> pd.DataFrame:
    """Append the hybrid model: TFT and Box-Tiao ARIMAX forecasts, averaged."""
    parts = [predictions[predictions["model"] == m].set_index(["category", "origin", "horizon"])
             for m in HYBRID_MEMBERS]
    if any(p.empty for p in parts):
        return predictions
    hybrid = parts[0].copy()
    for col in ("q10", "q50", "q90"):
        hybrid[col] = combine_quantiles([p[col].to_numpy() for p in parts])
    hybrid["model"] = "hybrid"
    return pd.concat([predictions, hybrid.reset_index()], ignore_index=True)


def _to_rows(scaled: dict[str, np.ndarray], windows: Windows, panel: pd.DataFrame,
             state: FittedState, origin: int, H: int) -> list[dict]:
    """Convert scaled quantile predictions at one origin into SGD rows with actuals."""
    rows = []
    for i, cat in enumerate(windows.category):
        grp = panel[panel["category"] == cat].set_index("time_idx")
        origin_premium = float(grp.loc[origin, "premium"])
        for name, pred in scaled.items():
            sgd = state.target_scaler.inverse(cat, pred[i].reshape(-1)).reshape(pred[i].shape)
            for h in range(H):
                future = grp.loc[origin + h + 1]
                rows.append({
                    "model": name, "category": cat, "origin": origin, "horizon": h + 1,
                    "month": future["month"], "bidding_no": int(future["bidding_no"]),
                    "actual": float(future["premium"]), "origin_premium": origin_premium,
                    "q10": float(sgd[h, 0]), "q50": float(sgd[h, 1]), "q90": float(sgd[h, 2]),
                })
    return rows


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
def _pinball(y, q, tau):
    return np.maximum(tau * (y - q), (tau - 1) * (y - q))


def summarise(df: pd.DataFrame) -> dict:
    y, p50 = df["actual"].to_numpy(), df["q50"].to_numpy()
    origin = df["origin_premium"].to_numpy()
    err = p50 - y
    # Direction is only scored where the model actually calls a move (> 0.5%)
    # and the premium actually moved; a flat forecast (random walk) has no score.
    moved, called = np.sign(y - origin), np.sign(p50 - origin)
    scored = (np.abs(p50 / origin - 1) > 0.005) & (moved != 0)
    pinball = np.mean([_pinball(y, df[c].to_numpy(), tau).mean()
                       for c, tau in (("q10", 0.1), ("q50", 0.5), ("q90", 0.9))])
    return {
        "n": int(len(df)),
        "mae": float(np.abs(err).mean()),
        "rmse": float(np.sqrt((err ** 2).mean())),
        "mape": float((np.abs(err) / y).mean() * 100),
        "smape": float((2 * np.abs(err) / (np.abs(y) + np.abs(p50))).mean() * 100),
        "pinball": float(pinball),
        "coverage80": float(((df["q10"] <= y) & (y <= df["q90"])).mean() * 100),
        "direction": float((moved[scored] == called[scored]).mean() * 100) if scored.any() else None,
    }


def compute_metrics(predictions: pd.DataFrame) -> pd.DataFrame:
    """Metrics per (model, category, horizon) plus pooled rows (category '*', horizon 0)."""
    records = []
    for model, by_model in predictions.groupby("model"):
        for cat in [*CATEGORIES, "*"]:
            sub = by_model if cat == "*" else by_model[by_model["category"] == cat]
            for h in [0, *sorted(sub["horizon"].unique())]:
                part = sub if h == 0 else sub[sub["horizon"] == h]
                if len(part):
                    records.append({"model": model, "category": cat, "horizon": int(h), **summarise(part)})
    return pd.DataFrame(records)


def diebold_mariano(predictions: pd.DataFrame, model: str = "hybrid", horizon_lag: int = 5) -> dict:
    """Diebold-Mariano test of ``model`` against every other model.

    The loss is the pinball loss (p10/p50/p90), expressed as a % of the actual
    premium so every category counts equally, averaged per forecast origin.
    The DM statistic uses a Newey-West variance with ``horizon_lag`` lags,
    because multi-step forecasts from neighbouring origins overlap. A negative
    statistic means ``model`` has the lower loss; |DM| > 1.96 is significant
    at the 5% level.
    """
    from scipy import stats

    df = predictions.copy()
    df["loss"] = np.mean([_pinball(df["actual"], df[c], tau) for c, tau in
                          (("q10", 0.1), ("q50", 0.5), ("q90", 0.9))], axis=0) / df["actual"] * 100
    per_origin = df.pivot_table(index="origin", columns="model", values="loss", aggfunc="mean")
    out = {}
    for other in per_origin.columns:
        if other == model:
            continue
        d = (per_origin[model] - per_origin[other]).dropna().to_numpy()
        n, mean = len(d), d.mean()
        centred = d - mean
        variance = centred @ centred / n
        for lag in range(1, min(horizon_lag, n - 1) + 1):
            weight = 1 - lag / (horizon_lag + 1)
            variance += 2 * weight * (centred[lag:] @ centred[:-lag]) / n
        stat = mean / np.sqrt(max(variance, 1e-12) / n)
        out[other] = {"dm_stat": round(float(stat), 3),
                      "p_value": round(float(2 * (1 - stats.norm.cdf(abs(stat)))), 4),
                      "mean_loss_diff_pct": round(float(mean), 4), "n_origins": n}
    return out
