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
# this finds the folders relative to this file so that paths work on a laptop and in docker
PACKAGE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("COE_DATA_DIR", PACKAGE_DIR.parent / "data"))
SNAPSHOT_DIR = DATA_DIR / "snapshot"      # committed copy of the raw data (offline fallback)
ARTIFACT_DIR = DATA_DIR / "artifacts"     # trained weights, plots, etc. (not committed)

# this is the database address, the default matches docker compose so that no .env is needed
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+psycopg://coe:coe_password@localhost:5432/coe"
)

# this optional key gives higher rate limits on data.gov.sg, the public endpoint works without it so
# that nobody needs a key to run the project
DATAGOV_API_KEY = os.getenv("DATAGOV_API_KEY", "")

# ---------------------------------------------------------------------------
# Domain constants
# ---------------------------------------------------------------------------
# this is the list of COE categories so that every stage loops over them in the same order
CATEGORIES = ["A", "B", "C", "D", "E"]

# this holds the official name of each category so that the wording lives in one place
CATEGORY_NAMES = {
    "A": "Cars up to 1,600cc & 97kW (EVs up to 110kW)",
    "B": "Cars above 1,600cc or 97kW (EVs above 110kW)",
    "C": "Goods vehicles & buses",
    "D": "Motorcycles",
    "E": "Open (any vehicle except motorcycles)",
}

# this counts exercises in a year (bidding is twice a month) so that lags like 10 years can be
# written in exercises
EXERCISES_PER_YEAR = 24

# these are the quantiles every probabilistic model predicts. 0.1, 0.5 and 0.9 are the p10, p50 and
# p90 promised in the proposal, the extra levels are there so that the bid planner can draw a smooth
# win-probability curve
QUANTILES = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95]
# this stores where the median sits in the list so that code can pick it out by position
MEDIAN_INDEX = QUANTILES.index(0.50)

# these are the what-if supply scenarios, each number multiplies the quota of the next quarter (not
# announced yet) so that we can show how premiums react to more or less supply
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
# this groups the TFT settings so that one object can be passed around and saved with each run
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


# this groups the backtest settings so that the evaluation can be changed in one place
@dataclass
class BacktestConfig:
    """Rolling-origin evaluation settings (see evaluation.py)."""

    test_exercises: int = 72          # last 3 years are held out
    cv_folds: int = 3                 # validation folds used to choose the epoch count
    fold_exercises: int = 24          # each fold is one year of exercises
    origin_stride: int = 1            # a new forecast origin at every exercise
    select_epochs: bool = True        # False: use TFTConfig.default_epochs


# this bundles all the settings so that the pipeline only needs one config object
@dataclass
class PipelineConfig:
    tft: TFTConfig = field(default_factory=TFTConfig)
    backtest: BacktestConfig = field(default_factory=BacktestConfig)
    # this is the number of worker processes for the parallel parts (one Box-Tiao or ARIMA fit per
    # category, one model per training job) so that the job can use several CPU cores
    n_workers: int = int(os.getenv("COE_WORKERS", max(1, min(5, (os.cpu_count() or 2) - 1))))
    # this is the drop the proposal treats as meaningful (8%), it is saved with each run so that the
    # API can show the outlook's "chance of a drop of 8% or more"
    wait_threshold: float = 0.08


# this gives a cheaper setup with fewer epochs and forecast origins so that smoke tests finish
# quickly
def fast_config() -> PipelineConfig:
    """A much cheaper configuration for smoke tests and CI."""
    cfg = PipelineConfig()
    cfg.tft.default_epochs = 3
    cfg.backtest.select_epochs = False
    cfg.backtest.origin_stride = 6
    return cfg
