"""Neural forecasting models (PyTorch)."""

from .lstm import Seq2SeqLSTM
from .tft import TemporalFusionTransformer, quantile_loss

# this maps a name to its network class so that training can build either model from a string
MODEL_CLASSES = {"tft": TemporalFusionTransformer, "lstm": Seq2SeqLSTM}

# this lists what the package exports so that imports stay explicit
__all__ = ["MODEL_CLASSES", "Seq2SeqLSTM", "TemporalFusionTransformer", "quantile_loss"]
