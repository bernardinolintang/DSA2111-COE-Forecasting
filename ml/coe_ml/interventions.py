"""Box-Tiao intervention analysis.

For each category we fit a regression with ARIMA errors on the Box-Cox premium

    y_t = sum_k omega_k * I_k(t) + N_t,      N_t ~ ARIMA(p, 1, q)

where I_k(t) is the step / pulse / temporary dummy of policy event k. omega_k
is the level shift attributable to event k after accounting for the ordinary
dynamics N_t (Box & Tiao, 1975). The estimated shifts are converted into
percentage effects for the Policy Lab page and passed to the TFT as the
``policy_effect`` known-future input, so the network does not have to rediscover
each structural break from scratch.

Categories are independent, so they are fitted in parallel worker processes.
"""

from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX

from .features import POLICY_FEATURES, TargetScaler
from .parallel import parallel_map

log = logging.getLogger(__name__)

# these are the ARIMA orders to try so that AIC can pick the best one per category
ARIMA_ORDERS = [(p, 1, q) for p in range(3) for q in range(3)]
MIN_BEFORE, MIN_AFTER = 12, 6     # exercises needed on each side of an event


# this holds the result for one category so that the order, AIC and effects stay together
@dataclass
class InterventionResult:
    category: str
    order: tuple[int, int, int]
    aic: float
    effects: list[dict]           # one dict per estimated event


def identifiable_events(dummies: pd.DataFrame) -> list[str]:
    """Events with enough observations on both sides of the break to be estimated."""
    keep = []
    for col in POLICY_FEATURES:
        active = int(dummies[col].sum())
        if active >= MIN_AFTER and len(dummies) - active >= MIN_BEFORE:
            keep.append(col)
    return keep


# this fits one regression with ARIMA errors so that the policy dummies and normal market moves are
# estimated together
def fit_sarimax(y: np.ndarray, exog: np.ndarray | None, order) -> "SARIMAX":
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")   # convergence chatter on short series
        model = SARIMAX(y, exog=exog, order=order, trend="n",
                        enforce_stationarity=False, enforce_invertibility=False)
        return model.fit(disp=False, maxiter=200)


def select_and_fit(y: np.ndarray, exog: np.ndarray | None):
    """Pick the ARIMA(p,1,q) error structure with the lowest AIC."""
    best = None
    for order in ARIMA_ORDERS:
        try:
            # this skips an order that fails so that one bad fit does not stop the category
            res = fit_sarimax(y, exog, order)
        except Exception:     # singular designs etc. — just try the next order
            continue
        if np.isfinite(res.aic) and (best is None or res.aic < best[1].aic):
            best = (order, res)
    if best is None:
        raise RuntimeError("no ARIMA order could be fitted")
    return best


def _fit_category(args) -> InterventionResult:
    """Worker: fit the intervention model for one category (runs in a subprocess)."""
    cat, bc, dummies, scaler = args
    cols = identifiable_events(dummies)
    exog = dummies[cols].to_numpy(dtype=float) if cols else None
    order, res = select_and_fit(bc, exog)

    effects = []
    if cols:
        # this takes the first values of the fit since those are the dummies so that they line up
        # with cols
        params = np.asarray(res.params)[: len(cols)]
        bse = np.asarray(res.bse)[: len(cols)]
        pvalues = np.asarray(res.pvalues)[: len(cols)]
        for i, col in enumerate(cols):
            code = col.removeprefix("pol_")
            onset = int(np.argmax(dummies[col].to_numpy() > 0))
            ref_bc = float(np.mean(bc[max(0, onset - 12): onset]))   # level just before the event
            base = scaler_inverse_bc(scaler, cat, ref_bc)

            # this turns a Box-Cox shift into a percent change from the pre-event level so that the
            # Policy Lab can show plain percentages
            def pct(delta: float) -> float:
                return float(scaler_inverse_bc(scaler, cat, ref_bc + delta) / base - 1.0) * 100

            omega, se = float(params[i]), float(bse[i]) if np.isfinite(bse[i]) else None
            effects.append({
                "event_code": code, "category": cat, "omega": omega, "std_err": se,
                "p_value": float(pvalues[i]) if np.isfinite(pvalues[i]) else None,
                "pct_effect": pct(omega),
                "pct_low": pct(omega - 1.96 * se) if se is not None else None,
                "pct_high": pct(omega + 1.96 * se) if se is not None else None,
                "omega_target_units": scaler.boxcox_to_target_units(cat, omega),
            })
    return InterventionResult(cat, order, float(res.aic), effects)


def scaler_inverse_bc(scaler: TargetScaler, cat: str, bc_value: float) -> float:
    """Inverse Box-Cox for a single value in (unscaled) Box-Cox units."""
    scaled = (bc_value - scaler.lo[cat]) / (scaler.hi[cat] - scaler.lo[cat])
    return float(scaler.inverse(cat, [scaled])[0])


def fit_interventions(panel: pd.DataFrame, scaler: TargetScaler, n_workers: int = 1) -> list[InterventionResult]:
    """Fit Box-Tiao models for every category on the given (training) panel."""
    # this builds one job per category so that the five fits can run at the same time
    jobs = []
    for cat, grp in panel.sort_values("time_idx").groupby("category"):
        bc = scaler.boxcox(cat, grp["premium"].to_numpy())
        jobs.append((cat, bc, grp[POLICY_FEATURES].reset_index(drop=True), scaler))

    results = parallel_map(_fit_category, jobs, n_workers)

    # this logs every effect so that a run can be checked from the logs
    for r in results:
        summary = ", ".join(f"{e['event_code']}={e['pct_effect']:+.1f}%" for e in r.effects)
        log.info("Box-Tiao %s ARIMA%s: %s", r.category, r.order, summary or "no identifiable events")
    return results


def effects_lookup(results: list[InterventionResult]) -> dict[tuple[str, str], float]:
    """(event_code, category) -> omega in scaled-target units, for the TFT input."""
    return {(e["event_code"], r.category): e["omega_target_units"] for r in results for e in r.effects}
