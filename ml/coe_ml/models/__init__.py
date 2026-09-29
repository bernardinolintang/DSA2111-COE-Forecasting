"""Neural forecasting models (PyTorch)."""

from .lstm import Seq2SeqLSTM
from .tft import TemporalFusionTransformer, quantile_loss

MODEL_CLASSES = {"tft": TemporalFusionTransformer, "lstm": Seq2SeqLSTM}

__all__ = ["MODEL_CLASSES", "Seq2SeqLSTM", "TemporalFusionTransformer", "quantile_loss"]
