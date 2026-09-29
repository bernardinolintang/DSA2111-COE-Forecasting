"""Fitting and applying all data transformations in one place.

``fit_state`` learns everything that depends on data (Box-Cox parameters,
Box-Tiao effects, feature scalers) from a *fit* panel only; ``prepare`` applies
that state to any panel, including one extended with future exercises. Keeping
the two apart is what guarantees the backtest never peeks at test data.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .features import (POLICY_FEATURES, FeatureScaler, TargetScaler, add_target,
                       apply_policy_effects)
from .interventions import InterventionResult, effects_lookup, fit_interventions
from .policy_events import POLICY_EVENTS


@dataclass
class FittedState:
    target_scaler: TargetScaler
    feature_scaler: FeatureScaler
    interventions: list[InterventionResult]
    effects: dict[tuple[str, str], float]


def fit_state(fit_panel: pd.DataFrame, n_workers: int = 1) -> FittedState:
    target_scaler = TargetScaler().fit(fit_panel)
    interventions = fit_interventions(fit_panel, target_scaler, n_workers)
    effects = effects_lookup(interventions)
    with_target = add_target(apply_policy_effects(fit_panel, effects), target_scaler)
    feature_scaler = FeatureScaler().fit(with_target)
    return FittedState(target_scaler, feature_scaler, interventions, effects)


def prepare(panel: pd.DataFrame, state: FittedState, use_policy: bool = True) -> pd.DataFrame:
    """Apply a fitted state. ``use_policy=False`` removes all policy information
    (dummies and Box-Tiao effect) — the ablation used to measure its value.

    A policy dummy is only kept for (event, category) pairs that Box-Tiao could
    estimate from the fit data. An event that happened after the fit window
    (e.g. the 2025 injection during the backtest) would otherwise switch on an
    input the network never saw during training, whose weights are still random.
    """
    prepared = apply_policy_effects(panel, state.effects)
    for event, col in zip(POLICY_EVENTS, POLICY_FEATURES):
        unseen = ~prepared["category"].map(lambda c, e=event.code: (e, c) in state.effects)
        prepared.loc[unseen, col] = 0.0
    if not use_policy:
        prepared[POLICY_FEATURES + ["policy_effect"]] = 0.0
    prepared = add_target(prepared, state.target_scaler)
    return state.feature_scaler.transform(prepared)


def to_premium(state: FittedState, category: str, scaled) -> np.ndarray:
    """Scaled target -> SGD premium."""
    return state.target_scaler.inverse(category, scaled)
