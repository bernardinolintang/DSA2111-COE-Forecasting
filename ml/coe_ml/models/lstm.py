"""Sequence-to-sequence LSTM baseline.

Same inputs, anchoring and quantile head as the TFT, but without variable
selection, static enrichment or attention. Comparing the two isolates what the
TFT-specific components add.
"""

from __future__ import annotations

import torch
from torch import nn

from .tft import MonotoneQuantileHead


# this is a plain encoder-decoder with the same inputs so that any gain from the TFT comes from its
# extra parts
class Seq2SeqLSTM(nn.Module):
    def __init__(self, n_categories: int, n_encoder_vars: int, n_decoder_vars: int,
                 quantiles: list[float], horizon: int, hidden_size: int = 32, dropout: float = 0.1, **_):
        super().__init__()
        d = hidden_size
        # this is a small category embedding so that the LSTM knows which category it is on
        self.category = nn.Embedding(n_categories, 4)
        self.encoder = nn.LSTM(n_encoder_vars + 4, d, batch_first=True)
        self.decoder = nn.LSTM(n_decoder_vars + 4, d, batch_first=True)
        self.dropout = nn.Dropout(dropout)
        self.head = MonotoneQuantileHead(d, quantiles, horizon)

    def forward(self, static, encoder_x, decoder_x, anchor):
        cat = self.category(static)
        # this adds the category to every time step so that both LSTMs always have it
        enc_in = torch.cat([encoder_x, cat.unsqueeze(1).expand(-1, encoder_x.shape[1], -1)], dim=-1)
        dec_in = torch.cat([decoder_x, cat.unsqueeze(1).expand(-1, decoder_x.shape[1], -1)], dim=-1)
        # this passes the encoder's final state to the decoder so that the forecast carries on from
        # the past
        _, state = self.encoder(enc_in)
        out, _ = self.decoder(dec_in, state)
        return {"prediction": self.head(self.dropout(out), anchor.view(-1, 1, 1))}
