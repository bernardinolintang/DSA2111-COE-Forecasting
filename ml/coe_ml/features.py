"""Feature engineering: turns raw COE + macro data into a model-ready panel.

The panel has one row per (category, bidding exercise). ``time_idx`` is a
global exercise counter shared by all categories, so row ``t`` of Cat A and row
``t`` of Cat B refer to the same bidding exercise.

TFT input types (Lim et al., 2021):
  * static          – ``category``
  * known future    – ``KNOWN_FEATURES`` (quota supply, calendar, policy dummies,
                      Box-Tiao policy effect); available for forecast horizons
  * observed past   – ``OBSERVED_FEATURES`` (premium, bidding pressure, macro);
                      only available up to the forecast origin
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy import stats
from scipy.special import inv_boxcox

from .config import CATEGORIES, EXERCISES_PER_YEAR
from .policy_events import POLICY_EVENTS, indicator

# this names one dummy column per policy event so that a new event only needs adding in
# policy_events.py
POLICY_FEATURES = [f"pol_{e.code}" for e in POLICY_EVENTS]

# these inputs are known ahead of time so that the TFT can use them for future exercises too
KNOWN_FEATURES = [
    "quota_log",          # announced supply for this exercise
    "quota_chg_q",        # quarter-on-quarter change in supply
    "quota_10y_gap",      # supply 10 years ago vs now: the COE expiry cycle
    "has_10y",            # 1 when the 10-year lag is observable
    "month_sin",
    "month_cos",
    "bidding_second",     # 0 = first exercise of the month, 1 = second
    "pos_in_quarter",     # position (0..1) within the Feb/May/Aug/Nov quota quarter
    "policy_effect",      # Box-Tiao estimated level shift, in target units
    *POLICY_FEATURES,
]

# these inputs are only known up to the forecast date so that the model only sees them in the past
# window
OBSERVED_FEATURES = [
    "target",             # scaled Box-Cox premium (the series being forecast)
    "target_diff",        # change since the previous exercise
    "bid_ratio",          # log(bids received / quota): demand pressure
    "success_ratio",      # share of quota actually allocated
    "cpi_yoy",            # inflation, % year-on-year
    "sora_3m",            # borrowing cost, %
    "gdp_yoy",            # real GDP growth, % year-on-year
]

# this gives the encoder everything and the decoder only known inputs so that forecasts never rely
# on unknown values
ENCODER_FEATURES = OBSERVED_FEATURES + KNOWN_FEATURES
DECODER_FEATURES = KNOWN_FEATURES

# this lists features scaled per category since their level differs a lot so that one category does
# not swamp the rest
PER_CATEGORY_SCALED = {"quota_log"}
# this lists features left as they are (already bounded, binary or in target units) so that scaling
# does not distort them
UNSCALED = {"target", "target_diff", "has_10y", "month_sin", "month_cos",
            "bidding_second", "pos_in_quarter", "policy_effect", *POLICY_FEATURES}

# this is the 10 year lag counted in exercises so that we can look back at the COE expiry cycle
TEN_YEARS = 10 * EXERCISES_PER_YEAR


# ---------------------------------------------------------------------------
# Target transform: Box-Cox (variance stabilising) then Min-Max (0..1)
# ---------------------------------------------------------------------------
@dataclass
class TargetScaler:
    """Per-category Box-Cox + Min-Max transform of the COE premium."""

    lam: dict[str, float] = field(default_factory=dict)
    lo: dict[str, float] = field(default_factory=dict)
    hi: dict[str, float] = field(default_factory=dict)

    # this learns lambda, min and max per category so that every category gets its own transform
    def fit(self, panel: pd.DataFrame) -> "TargetScaler":
        for cat, grp in panel.groupby("category"):
            bc, lam = stats.boxcox(grp["premium"].astype(float).clip(lower=1.0))
            self.lam[cat], self.lo[cat], self.hi[cat] = float(lam), float(bc.min()), float(bc.max())
        return self

    # this applies only the Box-Cox step so that Box-Tiao can work in those units
    def boxcox(self, cat: str, premium) -> np.ndarray:
        return stats.boxcox(np.asarray(premium, dtype=float).clip(min=1.0), lmbda=self.lam[cat])

    # this squeezes the Box-Cox value into 0 to 1 so that all categories share one scale
    def transform(self, cat: str, premium) -> np.ndarray:
        return (self.boxcox(cat, premium) - self.lo[cat]) / (self.hi[cat] - self.lo[cat])

    # this undoes both steps so that forecasts can be shown in SGD
    def inverse(self, cat: str, scaled) -> np.ndarray:
        bc = np.asarray(scaled, dtype=float) * (self.hi[cat] - self.lo[cat]) + self.lo[cat]
        lam = self.lam[cat]
        if lam != 0:
            # this keeps values inside what the inverse accepts (lam * bc + 1 > 0) so that it never
            # returns NaN
            bound = (-1.0 / lam) + 1e-6
            bc = np.maximum(bc, bound) if lam > 0 else np.minimum(bc, bound)
        return inv_boxcox(bc, lam)

    def boxcox_to_target_units(self, cat: str, delta_bc: float) -> float:
        """Convert a level shift in Box-Cox units into scaled-target units."""
        return delta_bc / (self.hi[cat] - self.lo[cat])


@dataclass
class FeatureScaler:
    """Z-score scaling fitted on training rows only (no look-ahead leakage)."""

    mean: dict = field(default_factory=dict)
    std: dict = field(default_factory=dict)

    # this learns the mean and std of each feature so that inputs can be z-scored
    def fit(self, panel: pd.DataFrame) -> "FeatureScaler":
        for col in ENCODER_FEATURES:
            if col in UNSCALED:
                continue
            if col in PER_CATEGORY_SCALED:
                for cat, grp in panel.groupby("category"):
                    self.mean[(col, cat)] = float(grp[col].mean())
                    self.std[(col, cat)] = float(grp[col].std() or 1.0)
            else:
                self.mean[col] = float(panel[col].mean())
                self.std[col] = float(panel[col].std() or 1.0)
        return self

    # this z-scores a panel with the stored numbers so that new rows are scaled the same way as
    # training rows
    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        for col in ENCODER_FEATURES:
            if col in UNSCALED or col not in out:
                continue
            if col in PER_CATEGORY_SCALED:
                for cat in out["category"].unique():
                    m = out["category"] == cat
                    out.loc[m, col] = (out.loc[m, col] - self.mean[(col, cat)]) / self.std[(col, cat)]
            else:
                out[col] = (out[col] - self.mean[col]) / self.std[col]
        return out


# ---------------------------------------------------------------------------
# Panel construction
# ---------------------------------------------------------------------------
def build_panel(coe: pd.DataFrame, macro: pd.DataFrame) -> pd.DataFrame:
    """Join COE results with macro indicators and derive raw (unscaled) features."""
    coe = coe.copy()
    coe["month"] = pd.to_datetime(coe["month"])

    # this keeps only exercises where all five categories were auctioned so that every time_idx has
    # a full set of rows
    counts = coe.groupby(["month", "bidding_no"])["category"].nunique()
    complete = counts[counts == len(CATEGORIES)].index
    coe = coe.set_index(["month", "bidding_no"]).loc[complete].reset_index()

    # this gives every exercise one shared counter so that row t means the same exercise in every
    # category
    exercises = (
        coe[["month", "bidding_no"]].drop_duplicates().sort_values(["month", "bidding_no"])
        .reset_index(drop=True)
    )
    exercises["time_idx"] = np.arange(len(exercises))
    panel = coe.merge(exercises, on=["month", "bidding_no"])
    # this adds the macro features by month so that each exercise has the economy numbers known at
    # that time
    panel = panel.merge(macro_features(macro), on="month", how="left")
    # this fills small gaps forward then backward so that the model never gets a NaN input
    for col in ["cpi_yoy", "sora_3m", "gdp_yoy"]:
        panel[col] = panel.groupby("category")[col].transform(lambda s: s.ffill().bfill())

    # this measures demand against supply so that the model can see how hot each exercise was
    panel["bid_ratio"] = np.log(panel["bids_received"].clip(lower=1) / panel["quota"].clip(lower=1))
    panel["success_ratio"] = panel["bids_success"] / panel["quota"].clip(lower=1)
    panel = panel.sort_values(["category", "time_idx"]).reset_index(drop=True)
    return add_known_features(panel)


def macro_features(macro: pd.DataFrame) -> pd.DataFrame:
    """Monthly macro features, lagged by their publication delay.

    Bidding exercises close around days 3-9 and 17-23 of the month. CPI for
    month m is released around the 23rd of month m+1, after both exercises, so
    it is first usable in month m+2. SORA for month m is public as soon as the
    month ends (usable in m+1), and GDP for a quarter about two months after it
    ends. Lagging prevents the model from "seeing" statistics that were not
    public at the time of the auction.
    """
    wide = macro.pivot_table(index="month", columns="indicator", values="value")
    wide.index = pd.to_datetime(wide.index)
    monthly = wide.resample("MS").last()

    # this turns CPI into yearly inflation and delays it 2 months so that it follows the release
    # timing
    cpi = monthly["cpi_all_items"]
    out = pd.DataFrame(index=monthly.index)
    out["cpi_yoy"] = (cpi / cpi.shift(12) - 1.0).mul(100).shift(2)
    # this delays SORA by 1 month so that only finished months are used
    out["sora_3m"] = monthly["sora_3m"].shift(1)
    # this works out yearly GDP growth on quarter-end months so that it can be spread to monthly
    # rows after a 2 month delay
    gdp = monthly["gdp_real"].dropna()            # quarter-end months only
    gdp_yoy = (gdp / gdp.shift(4) - 1.0).mul(100)
    out["gdp_yoy"] = gdp_yoy.reindex(monthly.index).shift(2).ffill()
    return out.reset_index(names="month")


def add_known_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Derive known-future features. Works on history and on future rows alike."""
    panel = panel.sort_values(["category", "time_idx"]).copy()
    month = pd.to_datetime(panel["month"])
    q = np.log(panel["quota"].clip(lower=1).astype(float))
    grouped = q.groupby(panel["category"])

    # this builds the supply features so that the model sees the quota, how it changed and the 10
    # year expiry gap
    panel["quota_log"] = q
    panel["quota_chg_q"] = (q - grouped.shift(6)).fillna(0.0)
    lag10 = grouped.shift(TEN_YEARS)
    panel["has_10y"] = lag10.notna().astype(float)
    panel["quota_10y_gap"] = (lag10 - q).fillna(0.0)

    # this turns the month into sin and cos so that December and January end up close together
    angle = 2 * np.pi * (month.dt.month - 1) / 12
    panel["month_sin"], panel["month_cos"] = np.sin(angle), np.cos(angle)
    panel["bidding_second"] = (panel["bidding_no"] == 2).astype(float)
    # quota quarters run Feb-Apr, May-Jul, Aug-Oct, Nov-Jan (6 exercises each), this gives each
    # exercise its position so that the model knows where it is in the quarter
    panel["pos_in_quarter"] = (((month.dt.month - 2) % 3) * 2 + panel["bidding_no"] - 1) / 5.0

    # this switches on each policy dummy only for the categories it affects so that a car policy
    # does not touch unrelated categories
    dates = month.dt.date
    for event, col in zip(POLICY_EVENTS, POLICY_FEATURES):
        panel[col] = [
            indicator(event, d) if event.affects(c) else 0.0
            for d, c in zip(dates, panel["category"])
        ]
    # this starts policy_effect at 0 so that the column exists before Box-Tiao fills it
    if "policy_effect" not in panel:
        panel["policy_effect"] = 0.0
    return panel


def apply_policy_effects(panel: pd.DataFrame, effects: dict[tuple[str, str], float]) -> pd.DataFrame:
    """Set ``policy_effect`` = sum over events of omega(event, category) * dummy.

    ``effects`` maps (event_code, category) -> omega in scaled-target units.
    """
    panel = panel.copy()
    total = np.zeros(len(panel))
    for event, col in zip(POLICY_EVENTS, POLICY_FEATURES):
        omega = panel["category"].map(lambda c, e=event.code: effects.get((e, c), 0.0)).to_numpy()
        total += omega * panel[col].to_numpy()
    panel["policy_effect"] = total
    return panel


def add_target(panel: pd.DataFrame, scaler: TargetScaler) -> pd.DataFrame:
    """Attach the scaled target and its first difference."""
    panel = panel.copy()
    panel["target"] = np.nan
    for cat in panel["category"].unique():
        m = (panel["category"] == cat) & panel["premium"].notna()
        panel.loc[m, "target"] = scaler.transform(cat, panel.loc[m, "premium"])
    panel["target_diff"] = panel.groupby("category")["target"].diff().fillna(0.0)
    return panel


# ---------------------------------------------------------------------------
# Future exercises
# ---------------------------------------------------------------------------
def next_exercises(month: pd.Timestamp, bidding_no: int, n: int) -> list[tuple[pd.Timestamp, int]]:
    """The ``n`` bidding exercises after (month, bidding_no)."""
    # this steps through the twice-a-month calendar so that we know the date of each coming exercise
    out, m, b = [], pd.Timestamp(month), int(bidding_no)
    for _ in range(n):
        if b == 1:
            b = 2
        else:
            m, b = m + pd.DateOffset(months=1), 1
        out.append((m, b))
    return out


def quota_quarter(month: pd.Timestamp) -> tuple[int, int]:
    """Identify the Feb/May/Aug/Nov quota quarter a month belongs to."""
    # this shifts the month back by one so that Feb-Apr falls in one calendar quarter
    shifted = pd.Timestamp(month) - pd.DateOffset(months=1)   # Feb -> Jan, so quarters align
    return shifted.year, (shifted.month - 1) // 3


def extend_with_future(history: pd.DataFrame, horizon: int, quota_multiplier: float = 1.0) -> pd.DataFrame:
    """Append ``horizon`` future exercises per category with assumed supply.

    Quota rule (what is actually known at the forecast origin):
      * rest of the current quota quarter – the announced quota, i.e. the latest one
      * later quarters – not announced yet; latest quota x ``quota_multiplier``
        (1.0 for the base case, other values for what-if scenarios)
    Observed columns (premium, bids, macro) are NaN in the future rows.
    """
    last = history.sort_values("time_idx").groupby("category").tail(1)
    rows = []
    for _, row in last.iterrows():
        current_q = quota_quarter(row["month"])
        for step, (m, b) in enumerate(next_exercises(row["month"], row["bidding_no"], horizon), start=1):
            # this keeps the announced quota in the current quarter and changes only later ones so
            # that a scenario never alters a quota that is already public
            same_quarter = quota_quarter(m) == current_q
            quota = row["quota"] if same_quarter else round(row["quota"] * quota_multiplier)
            rows.append({"category": row["category"], "time_idx": row["time_idx"] + step,
                         "month": m, "bidding_no": b, "quota": int(quota), "is_future": True})
    future = pd.DataFrame(rows)
    # this joins history and future and rebuilds the known features so that lags carry across the
    # join
    combined = pd.concat([history.assign(is_future=False), future], ignore_index=True)
    return add_known_features(combined)
