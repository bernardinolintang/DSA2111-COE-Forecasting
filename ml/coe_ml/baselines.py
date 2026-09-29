"""Baseline forecasters for the performance comparison (report Section 4).

All baselines see exactly the same information as the TFT at each forecast
origin and return p10 / p50 / p90 in the scaled target space:

  * ``naive``          – random walk; intervals from historical h-step changes
  * ``arima``          – ARIMA(p,1,q) on the Box-Cox premium (AIC-selected)
  * ``arimax_boxtiao`` – the same plus Box-Tiao policy dummies (econometric model)
  * ``gbm``            – gradient-boosted trees with quantile loss (direct strategy)
  * ``lstm``           – seq2seq LSTM (trained in evaluation.py via training.py)
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import HistGradientBoostingRegressor

from .features import ENCODER_FEATURES, POLICY_FEATURES
from .interventions import identifiable_events, select_and_fit
from .parallel import parallel_map
from .training import Windows

BASELINE_QUANTILES = [0.1, 0.5, 0.9]


# ---------------------------------------------------------------------------
# Random walk
# ---------------------------------------------------------------------------
class NaiveForecaster:
    """Last value as the median; empirical h-step changes give the interval."""

    def fit(self, train_panel: pd.DataFrame, horizon: int) -> "NaiveForecaster":
        self.offsets = {}
        for cat, grp in train_panel.sort_values("time_idx").groupby("category"):
            y = grp["target"].to_numpy()
            self.offsets[cat] = np.array([
                np.quantile(y[h:] - y[:-h], BASELINE_QUANTILES) for h in range(1, horizon + 1)
            ])                                                        # [H, 3]
            self.offsets[cat][:, 1] = 0.0                               # median = no change
        return self

    def predict(self, windows: Windows) -> np.ndarray:
        return np.stack([anchor + self.offsets[cat] for anchor, cat in zip(windows.anchor, windows.category)])


# ---------------------------------------------------------------------------
# ARIMA / ARIMAX (Box-Tiao)
# ---------------------------------------------------------------------------
def _fit_arima_job(job):
    """Worker: AIC-select and fit one category's ARIMA(X) model."""
    cat, y, exog, cols = job
    order, res = select_and_fit(y, exog)
    return cat, (order, res, cols)


class ArimaForecaster:
    """Per-category ARIMA fitted once on the training data.

    At each origin the fitted parameters are re-applied to the data observed so
    far (Kalman filter update, no re-estimation), which mirrors how the neural
    models are evaluated.
    """

    def __init__(self, with_interventions: bool):
        self.with_interventions = with_interventions

    def fit(self, train_panel: pd.DataFrame, n_workers: int = 1) -> "ArimaForecaster":
        jobs = []
        for cat, grp in train_panel.sort_values("time_idx").groupby("category"):
            cols = identifiable_events(grp[POLICY_FEATURES]) if self.with_interventions else []
            exog = grp[cols].to_numpy(dtype=float) if cols else None
            jobs.append((cat, grp["target"].to_numpy(), exog, cols))
        self.models = dict(parallel_map(_fit_arima_job, jobs, n_workers))
        return self

    def predict_origin(self, cat: str, history: pd.DataFrame, future: pd.DataFrame,
                       quantiles: list[float] = BASELINE_QUANTILES) -> np.ndarray:
        """history: category rows up to the origin; future: the next H rows (known features).

        Returns Gaussian quantiles of the Box-Cox forecast, shape [H, len(quantiles)].
        """
        order, res, cols = self.models[cat]
        exog = history[cols].to_numpy(dtype=float) if cols else None
        future_exog = future[cols].to_numpy(dtype=float) if cols else None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            updated = res.apply(history["target"].to_numpy(), exog=exog)
            fc = updated.get_forecast(steps=len(future), exog=future_exog)
        mean, se = np.asarray(fc.predicted_mean), np.sqrt(np.asarray(fc.var_pred_mean))
        return np.stack([mean + stats.norm.ppf(q) * se for q in quantiles], axis=-1)


# ---------------------------------------------------------------------------
# Gradient boosting
# ---------------------------------------------------------------------------
TARGET_LAGS = 12


def _gbm_features(windows: Windows) -> tuple[np.ndarray, np.ndarray]:
    """Flatten each (window, horizon) pair into one tabular row."""
    n, H = windows.y.shape
    target_col = ENCODER_FEATURES.index("target")
    lags = windows.enc[:, -TARGET_LAGS:, target_col] - windows.anchor[:, None]      # relative history
    last_obs = windows.enc[:, -1, :]                                                  # all inputs at origin
    rows, horizons = [], []
    for h in range(H):
        rows.append(np.column_stack([lags, last_obs, windows.dec[:, h, :],
                                     np.full(n, h + 1), windows.static]))
        horizons.append(np.full(n, h))
    return np.vstack(rows), np.concatenate(horizons)


class GBMForecaster:
    """One quantile-loss gradient-boosting model per quantile; horizon is a feature."""

    def fit(self, train: Windows, seed: int = 0) -> "GBMForecaster":
        X, h = _gbm_features(train)
        delta = (train.y - train.anchor[:, None]).T.reshape(-1)          # same horizon-major order as X
        self.models = [
            HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=300, learning_rate=0.05,
                                          max_leaf_nodes=15, min_samples_leaf=20, random_state=seed).fit(X, delta)
            for q in BASELINE_QUANTILES
        ]
        return self

    def predict(self, windows: Windows) -> np.ndarray:
        X, _ = _gbm_features(windows)
        n, H = len(windows), windows.dec.shape[1]
        preds = np.stack([m.predict(X) for m in self.models], axis=-1).reshape(H, n, -1).transpose(1, 0, 2)
        preds = np.sort(preds, axis=-1)                       # guard against quantile crossing
        return preds + windows.anchor[:, None, None]

