"""Data ingestion from public Singapore government APIs.

Sources (no API key required):
  * COE bidding results – LTA dataset on data.gov.sg (CKAN datastore API)
  * CPI (2024 = 100), SORA 3-month, real GDP – SingStat Table Builder API

Every successful download is also written to ``data/snapshot`` so the pipeline
still runs when the network is unavailable (e.g. inside a locked-down cloud VM)
or when an upstream API changes. ``load_*`` functions fall back to the snapshot
automatically.
"""

from __future__ import annotations

import logging
from datetime import date
from pathlib import Path

import pandas as pd
import requests

from . import config

log = logging.getLogger(__name__)

DATAGOV_URL = "https://data.gov.sg/api/action/datastore_search"
COE_RESOURCE_ID = "d_69b3380ad7e51aff3a7dcc84eba52b8a"   # "COE Bidding Results / Prices"
SINGSTAT_URL = "https://tablebuilder.singstat.gov.sg/api/table/tabledata/{table_id}"

# (indicator name, SingStat table id, row text, frequency)
MACRO_SERIES = [
    ("cpi_all_items", "M213751", "All Items", "M"),
    ("sora_3m", "M700071", "Compounded Singapore Overnight Rate Average (SORA) - 3 Month", "M"),
    ("gdp_real", "M015661", "GDP In Chained (2015) Dollars", "Q"),
]

TIMEOUT = 30
HEADERS = {"User-Agent": "coe-forecasting/1.0 (NUS DSA2111 student project)"}


# ---------------------------------------------------------------------------
# COE results
# ---------------------------------------------------------------------------
def fetch_coe_results(page_size: int = 1000) -> pd.DataFrame:
    """Download every COE bidding result from data.gov.sg (paginated)."""
    headers = dict(HEADERS)
    if config.DATAGOV_API_KEY:
        headers["x-api-key"] = config.DATAGOV_API_KEY

    records: list[dict] = []
    offset = 0
    while True:
        params = {"resource_id": COE_RESOURCE_ID, "limit": page_size, "offset": offset}
        resp = requests.get(DATAGOV_URL, params=params, headers=headers, timeout=TIMEOUT)
        resp.raise_for_status()
        result = resp.json()["result"]
        batch = result["records"]
        records.extend(batch)
        offset += len(batch)
        if not batch or offset >= result["total"]:
            break
    log.info("Fetched %d COE records from data.gov.sg", len(records))
    return clean_coe_results(pd.DataFrame.from_records(records))


def clean_coe_results(raw: pd.DataFrame) -> pd.DataFrame:
    """Normalise raw data.gov.sg records into typed, tidy columns."""
    df = pd.DataFrame(
        {
            "month": pd.to_datetime(raw["month"], format="%Y-%m").dt.date,
            "bidding_no": raw["bidding_no"].astype(int),
            "category": raw["vehicle_class"].str.replace("Category ", "", regex=False).str.strip(),
        }
    )
    for col in ["quota", "bids_success", "bids_received", "premium"]:
        # Values arrive as strings and occasionally contain thousands separators.
        df[col] = pd.to_numeric(raw[col].astype(str).str.replace(",", ""), errors="coerce")
    df = df.dropna(subset=["premium"])
    df = df[df["category"].isin(config.CATEGORIES)]
    df[["quota", "bids_success", "bids_received", "premium"]] = (
        df[["quota", "bids_success", "bids_received", "premium"]].fillna(0).astype(int)
    )
    return (
        df.drop_duplicates(subset=["month", "bidding_no", "category"], keep="last")
        .sort_values(["month", "bidding_no", "category"])
        .reset_index(drop=True)
    )


# ---------------------------------------------------------------------------
# Macro indicators
# ---------------------------------------------------------------------------
def _parse_singstat_key(key: str, freq: str) -> date:
    """'2026 Aug' -> 2026-08-01 ; '2026 2Q' -> 2026-06-01 (last month of quarter)."""
    year, period = key.split()
    if freq == "M":
        return pd.to_datetime(f"{year} {period}", format="%Y %b").date()
    quarter = int(period[0])
    return date(int(year), quarter * 3, 1)


def fetch_singstat_series(table_id: str, row_text: str, freq: str) -> pd.Series:
    """Download one row of a SingStat Table Builder table as a dated Series."""
    url = SINGSTAT_URL.format(table_id=table_id)
    resp = requests.get(url, params={"limit": 5000}, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    rows = resp.json()["Data"]["row"]
    matches = [r for r in rows if r["rowText"].strip() == row_text]
    if not matches:
        raise KeyError(f"row {row_text!r} not found in SingStat table {table_id}")
    points = {
        _parse_singstat_key(col["key"], freq): float(col["value"])
        for col in matches[0]["columns"]
        if col["value"] not in ("", "na", "-")
    }
    return pd.Series(points).sort_index()


def fetch_macro() -> pd.DataFrame:
    """Download all macro series into long format (month, indicator, value, source)."""
    frames = []
    for name, table_id, row_text, freq in MACRO_SERIES:
        series = fetch_singstat_series(table_id, row_text, freq)
        frames.append(
            pd.DataFrame(
                {
                    "month": series.index,
                    "indicator": name,
                    "value": series.values,
                    "source": f"SingStat {table_id}",
                }
            )
        )
        log.info("Fetched %s: %d points up to %s", name, len(series), series.index.max())
    return pd.concat(frames, ignore_index=True)


# ---------------------------------------------------------------------------
# Snapshot fallback
# ---------------------------------------------------------------------------
def _snapshot_path(name: str) -> Path:
    return config.SNAPSHOT_DIR / f"{name}.csv"


def _save_snapshot(df: pd.DataFrame, name: str) -> None:
    config.SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(_snapshot_path(name), index=False)


def _read_snapshot(name: str) -> pd.DataFrame:
    df = pd.read_csv(_snapshot_path(name))
    df["month"] = pd.to_datetime(df["month"]).dt.date
    return df


def load_coe_results(offline: bool = False) -> pd.DataFrame:
    """Live COE results, falling back to the committed snapshot on any failure."""
    if not offline:
        try:
            df = fetch_coe_results()
            _save_snapshot(df, "coe_results")
            return df
        except Exception as exc:  # network errors, schema changes, rate limits...
            log.warning("COE download failed (%s); using snapshot", exc)
    return _read_snapshot("coe_results")


def load_macro(offline: bool = False) -> pd.DataFrame:
    """Live macro indicators, falling back to the committed snapshot on any failure."""
    if not offline:
        try:
            df = fetch_macro()
            _save_snapshot(df, "macro_indicators")
            return df
        except Exception as exc:
            log.warning("Macro download failed (%s); using snapshot", exc)
    return _read_snapshot("macro_indicators")
