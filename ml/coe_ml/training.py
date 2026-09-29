"""Sliding-window datasets, training loop and inference for the neural models.

Training several random seeds and averaging their quantiles (a small deep
ensemble) makes the forecasts noticeably more stable on a dataset this small.
Seeds are independent, so they train in parallel worker processes (see
parallel.py). Weights travel back to the parent as NumPy arrays, which avoids
PyTorch's shared-memory tensor passing (limited to 64 MB in Docker by default).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import torch

from .config import CATEGORIES, TFTConfig
from .features import DECODER_FEATURES, ENCODER_FEATURES
from .models import MODEL_CLASSES, quantile_loss
from .parallel import parallel_map

log = logging.getLogger(__name__)
CATEGORY_INDEX = {c: i for i, c in enumerate(CATEGORIES)}


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------
@dataclass
class Windows:
    """A batch of (encoder, decoder) samples cut from the panel."""

    static: np.ndarray        # [N]          category index
    enc: np.ndarray           # [N, L, n_enc]
    dec: np.ndarray           # [N, H, n_dec]
    y: np.ndarray             # [N, H]       scaled target (NaN when unknown)
    anchor: np.ndarray        # [N]          scaled target at the origin
    category: np.ndarray      # [N]          category letter
    origin: np.ndarray        # [N]          time_idx of the forecast origin

    def __len__(self) -> int:
        return len(self.static)

    def subset(self, mask: np.ndarray) -> "Windows":
        return Windows(*(getattr(self, f)[mask] for f in Windows.__dataclass_fields__))

    @staticmethod
    def concat(parts: list["Windows"]) -> "Windows":
        parts = [p for p in parts if len(p)]
        return Windows(*(np.concatenate([getattr(p, f) for p in parts]) for f in Windows.__dataclass_fields__))

    def tensors(self) -> tuple[torch.Tensor, ...]:
        return (torch.as_tensor(self.static, dtype=torch.long),
                torch.as_tensor(self.enc, dtype=torch.float32),
                torch.as_tensor(self.dec, dtype=torch.float32),
                torch.as_tensor(self.anchor, dtype=torch.float32),
                torch.as_tensor(np.nan_to_num(self.y), dtype=torch.float32))


def make_windows(panel: pd.DataFrame, L: int, H: int, origins: dict[str, list[int]] | None = None,
                 require_target: bool = True) -> Windows:
    """Cut encoder/decoder windows from a *prepared* (scaled) panel.

    ``origins`` maps category -> list of origin time indices; ``None`` means every
    origin for which a full window exists.
    """
    parts = []
    for cat, grp in panel.sort_values("time_idx").groupby("category"):
        grp = grp.reset_index(drop=True)
        enc_all = grp[ENCODER_FEATURES].to_numpy(dtype=np.float32)
        dec_all = grp[DECODER_FEATURES].to_numpy(dtype=np.float32)
        target = grp["target"].to_numpy(dtype=np.float32)
        pos_of = {t: i for i, t in enumerate(grp["time_idx"])}

        wanted = origins.get(cat, []) if origins is not None else grp["time_idx"].tolist()
        rows = []
        for t in wanted:
            pos = pos_of.get(t)
            if pos is None or pos - L + 1 < 0 or pos + H >= len(grp):
                continue
            y = target[pos + 1: pos + H + 1]
            if require_target and np.isnan(y).any():
                continue
            rows.append((enc_all[pos - L + 1: pos + 1], dec_all[pos + 1: pos + H + 1], y, target[pos], t))
        if not rows:
            continue
        enc, dec, y, anchor, origin = map(np.stack, zip(*rows))
        parts.append(Windows(np.full(len(rows), CATEGORY_INDEX[cat]), enc, dec, y, anchor,
                             np.full(len(rows), cat), origin))
    if not parts:
        raise ValueError("no windows could be built — check encoder length / horizon / origins")
    windows = Windows.concat(parts)
    if np.isnan(windows.enc).any() or np.isnan(windows.dec).any():
        raise ValueError("NaN in model inputs — feature preparation is incomplete")
    return windows


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------
@dataclass
class TrainJob:
    kind: str                         # "tft" or "lstm"
    train: Windows
    val: Windows | None               # when given, the val loss is recorded after every epoch
    cfg: TFTConfig
    seed: int
    epochs: int
    threads: int = 1


@dataclass
class TrainResult:
    kind: str
    seed: int
    state_dict: dict                  # parameter name -> NumPy array
    val_curve: list[float] = field(default_factory=list)


def build_model(kind: str, cfg: TFTConfig) -> torch.nn.Module:
    return MODEL_CLASSES[kind](
        n_categories=len(CATEGORIES), n_encoder_vars=len(ENCODER_FEATURES),
        n_decoder_vars=len(DECODER_FEATURES), quantiles=cfg.quantiles, horizon=cfg.horizon,
        hidden_size=cfg.hidden_size, attention_heads=cfg.attention_heads, dropout=cfg.dropout,
    )


def step_scale(windows: Windows) -> np.ndarray:
    """Robust spread of the h-step change in the scaled target, per horizon.

    Premium changes are fat-tailed (2013 loan curbs, the 2021-23 surge), so the
    standard deviation overstates the typical move. The inter-decile range,
    divided by its value for a standard normal (2 x 1.2816), gives a scale
    whose Gaussian p10-p90 band matches the empirical 80% band exactly.
    """
    change = windows.y - windows.anchor[:, None]
    q10, q90 = np.nanquantile(change, [0.1, 0.9], axis=0)
    return np.maximum((q90 - q10) / (2 * 1.2815515655446004), 1e-3).astype(np.float32)


def _evaluate_loss(model, windows: Windows, quantiles) -> float:
    model.eval()
    with torch.no_grad():
        static, enc, dec, anchor, y = windows.tensors()
        return float(quantile_loss(model(static, enc, dec, anchor)["prediction"], y, quantiles))


def train_model(job: TrainJob) -> TrainResult:
    """AdamW with gradient clipping for a fixed number of epochs.

    The schedule deliberately does not depend on validation data, so a model
    trained during cross-validation and the final model trained on all data
    follow exactly the same recipe; only the epoch count is chosen by CV.
    """
    torch.set_num_threads(job.threads)
    torch.manual_seed(job.seed)
    rng = np.random.default_rng(job.seed)
    cfg = job.cfg

    model = build_model(job.kind, cfg)
    model.head.step_scale.copy_(torch.as_tensor(step_scale(job.train)))
    optimiser = torch.optim.AdamW(model.parameters(), lr=cfg.learning_rate, weight_decay=cfg.weight_decay)
    static, enc, dec, anchor, y = job.train.tensors()

    val_curve = []
    for _ in range(job.epochs):
        model.train()
        order = rng.permutation(len(job.train))
        for start in range(0, len(order), cfg.batch_size):
            idx = torch.as_tensor(order[start:start + cfg.batch_size])
            loss = quantile_loss(model(static[idx], enc[idx], dec[idx], anchor[idx])["prediction"],
                                 y[idx], cfg.quantiles)
            optimiser.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), cfg.grad_clip)
            optimiser.step()
        if job.val is not None:
            val_curve.append(_evaluate_loss(model, job.val, cfg.quantiles))

    weights = {name: tensor.detach().cpu().numpy() for name, tensor in model.state_dict().items()}
    return TrainResult(job.kind, job.seed, weights, val_curve)


def train_many(jobs: list[TrainJob], n_workers: int) -> list[TrainResult]:
    """Train independent jobs, in parallel processes when more than one worker is allowed."""
    return parallel_map(train_model, jobs, n_workers)


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------
@dataclass
class Ensemble:
    """Several trained seeds of one model kind; quantiles are averaged."""

    kind: str
    cfg: TFTConfig
    states: list[dict]

    def predict(self, windows: Windows, interpret: bool = False) -> dict:
        preds, enc_w, dec_w, attn = [], [], [], []
        static, enc, dec, anchor, _ = windows.tensors()
        for state in self.states:
            model = build_model(self.kind, self.cfg)
            model.load_state_dict({name: torch.as_tensor(array) for name, array in state.items()})
            model.eval()
            with torch.no_grad():
                out = model(static, enc, dec, anchor)
            preds.append(out["prediction"].numpy())
            if interpret and "attention" in out:
                enc_w.append(out["encoder_weights"].numpy())
                dec_w.append(out["decoder_weights"].numpy())
                attn.append(out["attention"].numpy())
        result = {"prediction": np.mean(preds, axis=0)}     # quantile averaging across seeds
        if interpret and attn:
            result.update(encoder_weights=np.mean(enc_w, axis=0), decoder_weights=np.mean(dec_w, axis=0),
                          attention=np.mean(attn, axis=0))
        return result
