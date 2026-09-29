"""Human-readable names shown in the UI for codes stored in the database."""

from __future__ import annotations

from datetime import date

CATEGORIES = {
    "A": {"name": "Cat A", "title": "Small cars",
          "description": "Cars up to 1,600cc and 97kW (130bhp); fully-electric cars up to 110kW."},
    "B": {"name": "Cat B", "title": "Large cars",
          "description": "Cars above 1,600cc or 97kW; fully-electric cars above 110kW."},
    "C": {"name": "Cat C", "title": "Goods vehicles & buses",
          "description": "Goods vehicles and buses."},
    "D": {"name": "Cat D", "title": "Motorcycles",
          "description": "Motorcycles."},
    "E": {"name": "Cat E", "title": "Open",
          "description": "Any vehicle except motorcycles. Usually tracks Cat B."},
}

SCENARIOS = {
    "base": {"label": "As announced", "multiplier": 1.0,
             "description": "Next quarter's quota stays at the current level."},
    "quota_minus_20": {"label": "−20% supply", "multiplier": 0.8,
                       "description": "Next quarter's quota is 20% lower than today."},
    "quota_minus_10": {"label": "−10% supply", "multiplier": 0.9,
                       "description": "Next quarter's quota is 10% lower than today."},
    "quota_plus_10": {"label": "+10% supply", "multiplier": 1.1,
                      "description": "Next quarter's quota is 10% higher than today."},
    "quota_plus_20": {"label": "+20% supply", "multiplier": 1.2,
                      "description": "Next quarter's quota is 20% higher than today."},
}

MODELS = {
    "hybrid": "Hybrid: TFT + Box-Tiao ARIMAX (ours)",
    "tft": "TFT with policy inputs",
    "tft_no_policy": "TFT, no policy inputs",
    "lstm": "Seq2Seq LSTM",
    "gbm": "Gradient boosting",
    "arimax_boxtiao": "ARIMAX + Box-Tiao",
    "arima": "ARIMA",
    "naive": "Random walk",
}

VARIABLES = {
    "target": "Premium history",
    "target_diff": "Recent momentum",
    "bid_ratio": "Bids per COE",
    "success_ratio": "Quota take-up",
    "cpi_yoy": "Inflation (CPI)",
    "sora_3m": "Interest rate (SORA)",
    "gdp_yoy": "GDP growth",
    "quota_log": "Quota supply",
    "quota_chg_q": "Quota change q/q",
    "quota_10y_gap": "10-year expiry cycle",
    "has_10y": "10-year data flag",
    "month_sin": "Month of year (sin)",
    "month_cos": "Month of year (cos)",
    "bidding_second": "1st vs 2nd exercise",
    "pos_in_quarter": "Place in quota quarter",
    "policy_effect": "Box-Tiao policy effect",
    "pol_mas_loan_curbs_2013": "2013 loan curbs",
    "pol_cat_a_power_cap_2014": "2014 Cat A power cap",
    "pol_mas_loan_easing_2016": "2016 loan easing",
    "pol_zero_growth_2018": "2018 zero growth",
    "pol_covid_resumption_2020": "2020 post-lockdown",
    "pol_ev_reclassification_2022": "2022 EV reclassification",
    "pol_cut_and_fill_2023": "2023 cut-and-fill",
    "pol_quota_injection_2025": "2025 quota injection",
}


def exercise_label(month: date, bidding_no: int) -> str:
    """e.g. 'Oct 2026 · 1st'."""
    return f"{month:%b %Y} · {'1st' if bidding_no == 1 else '2nd'}"
