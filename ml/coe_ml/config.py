"""Central configuration for the COE forecasting pipeline.

Every tunable number lives here so that experiments are reproducible and the
report can cite a single place for hyper-parameters. Values that differ between
environments (database URL, data directory) are read from environment variables.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths and connections
# ---------------------------------------------------------------------------
PACKAGE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("COE_DATA_DIR", PACKAGE_DIR.parent / "data"))
SNAPSHOT_DIR = DATA_DIR / "snapshot"      # committed copy of the raw data (offline fallback)
ARTIFACT_DIR = DATA_DIR / "artifacts"     # trained weights, plots, etc. (not committed)

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+psycopg://coe:coe_password@localhost:5432/coe"
)

# Optional: data.gov.sg issues API keys for higher rate limits. The public
# endpoint works without one, so this is never required.
DATAGOV_API_KEY = os.getenv("DATAGOV_API_KEY", "")

# ---------------------------------------------------------------------------
# Domain constants
# ---------------------------------------------------------------------------
CATEGORIES = ["A", "B", "C", "D", "E"]

CATEGORY_NAMES = {
    "A": "Cars up to 1,600cc & 97kW (EVs up to 110kW)",
    "B": "Cars above 1,600cc or 97kW (EVs above 110kW)",
    "C": "Goods vehicles & buses",
    "D": "Motorcycles",
    "E": "Open (any vehicle except motorcycles)",
}

# Exercises per year: bidding happens twice a month.
EXERCISES_PER_YEAR = 24

# Quantiles predicted by every probabilistic model. 0.1 / 0.5 / 0.9 are the
# p10 / p50 / p90 bounds promised in the proposal; the extra levels let the
# bid planner interpolate a smooth win-probability curve.
QUANTILES = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95]
MEDIAN_INDEX = QUANTILES.index(0.50)

# What-if supply scenarios: multiplier applied to the quota of the *next*
# (not yet announced) quota quarter.
SCENARIOS = {
    "base": 1.00,
    "quota_minus_20": 0.80,
    "quota_minus_10": 0.90,
    "quota_plus_10": 1.10,
    "quota_plus_20": 1.20,
}


# ---------------------------------------------------------------------------
# Model hyper-parameters
# ---------------------------------------------------------------------------
@dataclass
class TFTConfig:
    """Hyper-parameters for the Temporal Fusion Transformer (tuned with scripts/tune.py)."""

    encoder_length: int = 24          # one year of bidding exercises
    horizon: int = 6                  # one quota quarter ahead
    hidden_size: int = 16
    attention_heads: int = 4
    dropout: float = 0.3
    learning_rate: float = 1e-3
    weight_decay: float = 1e-4
    batch_size: int = 64
    max_epochs: int = 15              # length of the cross-validated learning curves
    default_epochs: int = 4           # used when no cross-validated choice exists yet
    grad_clip: float = 1.0
    seed: int = 42
    quantiles: list[float] = field(default_factory=lambda: list(QUANTILES))


@dataclass
class BacktestConfig:
    """Rolling-origin evaluation settings (see evaluation.py)."""

    test_exercises: int = 72          # last 3 years are held out
    cv_folds: int = 3                 # validation folds used to choose the epoch count
    fold_exercises: int = 24          # each fold is one year of exercises
    origin_stride: int = 1            # a new forecast origin at every exercise
    select_epochs: bool = True        # False: use TFTConfig.default_epochs


@dataclass
class PipelineConfig:
    tft: TFTConfig = field(default_factory=TFTConfig)
    backtest: BacktestConfig = field(default_factory=BacktestConfig)
    # Worker processes for the embarrassingly-parallel parts of the pipeline
    # (one Box-Tiao / ARIMA fit per category, one model per training job).
    n_workers: int = int(os.getenv("COE_WORKERS", max(1, min(5, (os.cpu_count() or 2) - 1))))
    # Wait / Buy threshold from the proposal: "wait" when the median forecast
    # for next quarter is more than 8% below today's premium.
    wait_threshold: float = 0.08


def fast_config() -> PipelineConfig:
    """A much cheaper configuration for smoke tests and CI."""
    cfg = PipelineConfig()
    cfg.tft.default_epochs = 3
    cfg.backtest.select_epochs = False
    cfg.backtest.origin_stride = 6
    return cfg
