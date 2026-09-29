"""End-to-end pipeline: ingest -> backtest -> train -> forecast -> persist.

    python -m coe_ml run            # full run, writes to Postgres
    python -m coe_ml run --fast     # quick smoke run (few epochs)
    python -m coe_ml run --no-db    # everything except the database writes

Stages
  1. Ingest COE results + macro data (live API, snapshot fallback)
  2. Backtest the hybrid, the TFT and the baselines on the last 3 years (rolling origins)
  3. Refit transforms + Box-Tiao on all data; train the production TFT ensemble
     and the Box-Tiao ARIMAX
  4. Forecast the next quota quarter for every category and supply scenario
     (hybrid = equal-weight average of TFT and ARIMAX quantiles)
  5. Extract interpretability (variable selection weights, attention by lag)
  6. Store everything as one ``model_runs`` row plus child tables
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from . import db, ingest
from .baselines import ArimaForecaster
from .config import CATEGORIES, QUANTILES, SCENARIOS, PipelineConfig
from .evaluation import MODEL_LABELS, backtest, combine_quantiles
from .features import DECODER_FEATURES, ENCODER_FEATURES, build_panel, extend_with_future
from .preparation import FittedState, fit_state, prepare
from .training import Ensemble, TrainJob, make_windows, train_many

log = logging.getLogger(__name__)
QUANTILE_COLUMNS = [f"q{int(q * 100):02d}" for q in QUANTILES]       # q05 ... q95


# ---------------------------------------------------------------------------
# Production model
# ---------------------------------------------------------------------------
@dataclass
class ProductionModel:
    """Everything needed to forecast: transforms, the TFT ensemble and the Box-Tiao ARIMAX."""

    state: FittedState
    prepared: pd.DataFrame
    tft: Ensemble
    arimax: ArimaForecaster


def train_production(panel: pd.DataFrame, cfg: PipelineConfig, epochs: int, n_seeds: int) -> ProductionModel:
    """Fit on *all* data for the epoch count chosen by cross-validation in the backtest."""
    state = fit_state(panel, cfg.n_workers)
    prepared = prepare(panel, state)
    windows = make_windows(prepared, cfg.tft.encoder_length, cfg.tft.horizon)
    threads = max(1, (os.cpu_count() or 2) // max(1, cfg.n_workers))
    jobs = [TrainJob("tft", windows, None, cfg.tft, seed=cfg.tft.seed + s, epochs=epochs, threads=threads)
            for s in range(n_seeds)]
    results = train_many(jobs, cfg.n_workers)
    arimax = ArimaForecaster(with_interventions=True).fit(prepared, cfg.n_workers)
    log.info("Production TFT: %d windows, %d epochs, %d seeds (+ Box-Tiao ARIMAX)", len(windows), epochs, n_seeds)
    return ProductionModel(state, prepared, Ensemble("tft", cfg.tft, [r.state_dict for r in results]), arimax)


def forecast_scenarios(panel: pd.DataFrame, model: ProductionModel, cfg: PipelineConfig) -> pd.DataFrame:
    """Hybrid quantile forecasts for the next ``horizon`` exercises under each supply scenario.

    The TFT reacts to the assumed quota; the ARIMAX half does not use quota, so a
    supply scenario moves the hybrid forecast by half as much as the TFT alone.
    """
    L, H = cfg.tft.encoder_length, cfg.tft.horizon
    origin = int(panel["time_idx"].max())
    inverse = model.state.target_scaler.inverse
    rows = []
    for scenario, multiplier in SCENARIOS.items():
        extended = extend_with_future(panel, H, multiplier)
        prepared = prepare(extended, model.state)
        windows = make_windows(prepared, L, H, {c: [origin] for c in CATEGORIES}, require_target=False)
        prediction = model.tft.predict(windows)["prediction"]                 # [5, H, Q] scaled
        future = extended[extended["is_future"]].set_index(["category", "time_idx"])
        for i, cat in enumerate(windows.category):
            grp = prepared[prepared["category"] == cat].sort_values("time_idx")
            econ = model.arimax.predict_origin(cat, grp[grp["time_idx"] <= origin],
                                               grp[grp["time_idx"] > origin], QUANTILES)
            members = [inverse(cat, p.reshape(-1)).reshape(p.shape) for p in (prediction[i], econ)]
            sgd = np.sort(combine_quantiles(members), axis=-1)
            for h in range(H):
                meta = future.loc[(cat, origin + h + 1)]
                rows.append({"category": cat, "scenario": scenario, "step": h + 1,
                             "month": meta["month"], "bidding_no": int(meta["bidding_no"]),
                             "quota": int(meta["quota"]),
                             **{col: float(v) for col, v in zip(QUANTILE_COLUMNS, sgd[h])}})
    return pd.DataFrame(rows)


def interpretability(prepared: pd.DataFrame, ensemble: Ensemble, cfg: PipelineConfig,
                     recent: int = 48) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Average TFT variable-selection weights and attention over recent windows."""
    L, H = cfg.tft.encoder_length, cfg.tft.horizon
    last = int(prepared["time_idx"].max())
    origins = {c: list(range(last - H - recent, last - H + 1)) for c in CATEGORIES}
    windows = make_windows(prepared, L, H, origins)
    out = ensemble.predict(windows, interpret=True)

    enc = out["encoder_weights"].mean(axis=(0, 1))
    dec = out["decoder_weights"].mean(axis=(0, 1))
    importance = pd.DataFrame(
        [{"component": "encoder", "variable": v, "importance": float(w)} for v, w in zip(ENCODER_FEATURES, enc)]
        + [{"component": "decoder", "variable": v, "importance": float(w)} for v, w in zip(DECODER_FEATURES, dec)]
    )

    # attention: [N, H, L+H]; keep the encoder part, average over decoder steps.
    attn_rows = []
    for cat in CATEGORIES:
        mask = windows.category == cat
        weights = out["attention"][mask][:, :, :L].mean(axis=(0, 1))       # [L], oldest first
        weights = weights / weights.sum()
        attn_rows += [{"category": cat, "lag": L - j, "weight": float(w)} for j, w in enumerate(weights)]
    return importance, pd.DataFrame(attn_rows)


def intervention_table(state: FittedState) -> pd.DataFrame:
    rows = [{k: v for k, v in effect.items() if k != "omega_target_units"}
            for result in state.interventions for effect in result.effects]
    return pd.DataFrame(rows)


def headline_metrics(metrics: pd.DataFrame, reference: str = "hybrid") -> dict:
    """Pooled accuracy per model plus the reference model's improvement over each other model."""
    pooled = metrics[(metrics["category"] == "*") & (metrics["horizon"] == 0)].set_index("model")
    summary = {m: {k: None if pd.isna(pooled.loc[m, k]) else round(float(pooled.loc[m, k]), 3)
                   for k in ["mape", "mae", "pinball", "coverage80", "direction"]}
               for m in pooled.index}
    ours = pooled.loc[reference, "pinball"]
    improvement = {m: round(float((pooled.loc[m, "pinball"] - ours) / pooled.loc[m, "pinball"] * 100), 2)
                   for m in pooled.index if m != reference}
    return {"pooled": summary, "reference": reference, "pinball_improvement_pct": improvement,
            "labels": MODEL_LABELS}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def run(cfg: PipelineConfig, *, offline: bool = False, skip_backtest: bool = False,
        n_seeds: int = 3, write_db: bool = True) -> dict:
    started = time.time()
    engine, run_id = None, None
    params = {"tft": asdict(cfg.tft), "backtest": asdict(cfg.backtest), "n_seeds": n_seeds,
              "encoder_features": ENCODER_FEATURES, "decoder_features": DECODER_FEATURES,
              "scenarios": SCENARIOS, "wait_threshold": cfg.wait_threshold}

    coe, macro = ingest.load_coe_results(offline), ingest.load_macro(offline)
    panel = build_panel(coe, macro)
    last = panel.sort_values("time_idx").iloc[-1]
    log.info("Panel: %d rows, %d exercises, last = %s #%d", len(panel), panel["time_idx"].nunique(),
             last["month"].strftime("%Y-%m"), last["bidding_no"])

    if write_db:
        engine = db.get_engine()
        db.wait_for_db(engine)
        db.ensure_schema(engine)
        db.save_raw_data(engine, coe, macro)
        run_id = db.start_run(engine, "hybrid_tft_boxtiao", params)

    try:
        outputs: dict[str, pd.DataFrame] = {}
        metrics_summary: dict = {}
        # A quick retrain (no backtest) reuses the epoch count that cross-validation
        # chose in the latest full run, so both kinds of run train the same way.
        epochs = (db.last_evaluated_epochs(engine) if write_db else None) or cfg.tft.default_epochs
        if not skip_backtest:
            bt = backtest(panel, cfg, n_seeds)
            epochs = bt.best_epochs["tft"]
            outputs["backtest_metrics"] = bt.metrics
            outputs["backtest_predictions"] = bt.predictions.drop(columns=["origin_premium"])
            metrics_summary = headline_metrics(bt.metrics)
            metrics_summary["cv_curves"] = bt.cv_curves
            metrics_summary["diebold_mariano"] = bt.dm_tests
            metrics_summary["test_start"] = _exercise_meta(panel, bt.test_start)
            _log_leaderboard(bt.metrics)

        model = train_production(panel, cfg, epochs, n_seeds)
        outputs["forecasts"] = forecast_scenarios(panel, model, cfg)
        outputs["intervention_effects"] = intervention_table(model.state)
        outputs["variable_importance"], outputs["attention_weights"] = interpretability(model.prepared, model.tft, cfg)
        metrics_summary["production_epochs"] = epochs
        _log_forecast(outputs["forecasts"], panel)

        if write_db:
            db.save_outputs(engine, run_id, outputs)
            db.finish_run(engine, run_id, "succeeded", metrics=metrics_summary,
                          data_through=last["month"].date(), last_bidding=int(last["bidding_no"]),
                          duration_s=time.time() - started)
            db.prune_runs(engine)
        log.info("Pipeline finished in %.0fs", time.time() - started)
        return {"run_id": run_id, "metrics": metrics_summary, "outputs": outputs}
    except Exception as exc:
        if write_db and run_id is not None:
            db.finish_run(engine, run_id, "failed", notes=repr(exc), duration_s=time.time() - started)
        raise


def _exercise_meta(panel: pd.DataFrame, time_idx: int) -> dict:
    row = panel[panel["time_idx"] == time_idx].iloc[0]
    return {"month": row["month"].strftime("%Y-%m"), "bidding_no": int(row["bidding_no"])}


def _log_leaderboard(metrics: pd.DataFrame) -> None:
    pooled = metrics[(metrics["category"] == "*") & (metrics["horizon"] == 0)].sort_values("pinball")
    log.info("Backtest leaderboard (all categories, all horizons):")
    for _, r in pooled.iterrows():
        direction = "  n/a" if pd.isna(r["direction"]) else f"{r['direction']:5.1f}%"
        log.info("  %-16s pinball %8.0f  MAPE %5.2f%%  cover80 %5.1f%%  direction %s",
                 r["model"], r["pinball"], r["mape"], r["coverage80"], direction)


def _log_forecast(forecasts: pd.DataFrame, panel: pd.DataFrame) -> None:
    base = forecasts[forecasts["scenario"] == "base"]
    latest = panel.sort_values("time_idx").groupby("category").tail(1).set_index("category")["premium"]
    for cat, grp in base.groupby("category"):
        end = grp.sort_values("step").iloc[-1]
        change = (end["q50"] / latest[cat] - 1) * 100
        log.info("Cat %s: now $%s -> p50 $%s (%+.1f%%), p10-p90 $%s-$%s", cat, f"{latest[cat]:,.0f}",
                 f"{end['q50']:,.0f}", change, f"{end['q10']:,.0f}", f"{end['q90']:,.0f}")


def configure_logging() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
