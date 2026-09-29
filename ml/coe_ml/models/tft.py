"""A compact, from-scratch Temporal Fusion Transformer (Lim et al., 2021).

Why not a library? pytorch-forecasting ties us to specific Lightning versions
and hides the architecture. Writing the ~250 lines ourselves keeps the Docker
image small and lets the report explain every block:

    static category ──► static covariate encoders ──► 4 context vectors
                                                       │  │  │  │
    past inputs   ──► Variable Selection ─► LSTM encoder ┐ (state init)
    known future  ──► Variable Selection ─► LSTM decoder ┘
                        │ gated skip
                        ▼
              static enrichment (GRN)
                        ▼
      interpretable multi-head attention (causal)
                        ▼
      position-wise GRN ─► quantile head (monotone) ─► p5 … p95

Three small, documented deviations from the paper:
  * **Anchoring** – the network predicts the change from the last observed
    (scaled) premium rather than the level, which suits a near-random-walk
    auction price.
  * **Random-walk scaling** – that change is expressed in units of the typical
    h-step move seen in training (``step_scale``), and the head is initialised
    at standard-normal quantiles. An untrained model is therefore exactly a
    calibrated random walk, and training only has to learn improvements on it.
  * **Monotone quantile head** – quantiles are built as median ± cumulative
    softplus increments so p10 ≤ p50 ≤ p90 always holds (no quantile crossing).
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F
from torch import nn


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------
class GatedLinearUnit(nn.Module):
    """Dropout -> Linear -> GLU. Lets the network switch a block off entirely."""

    def __init__(self, d_in: int, d_out: int, dropout: float):
        super().__init__()
        self.dropout = nn.Dropout(dropout)
        self.fc = nn.Linear(d_in, 2 * d_out)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.glu(self.fc(self.dropout(x)), dim=-1)


class GateAddNorm(nn.Module):
    """GLU(x) + skip, followed by LayerNorm."""

    def __init__(self, d_in: int, d_out: int, dropout: float):
        super().__init__()
        self.glu = GatedLinearUnit(d_in, d_out, dropout)
        self.norm = nn.LayerNorm(d_out)

    def forward(self, x: torch.Tensor, skip: torch.Tensor) -> torch.Tensor:
        return self.norm(self.glu(x) + skip)


class GatedResidualNetwork(nn.Module):
    """GRN(a, c) = LayerNorm(a + GLU(W1 ELU(W2 a + W3 c)))  — eq. (2)-(4) of the paper."""

    def __init__(self, d_in: int, d_hidden: int, d_out: int, dropout: float, d_context: int | None = None):
        super().__init__()
        self.skip = nn.Linear(d_in, d_out) if d_in != d_out else nn.Identity()
        self.fc1 = nn.Linear(d_in, d_hidden)
        self.context = nn.Linear(d_context, d_hidden, bias=False) if d_context else None
        self.fc2 = nn.Linear(d_hidden, d_hidden)
        self.gate = GateAddNorm(d_hidden, d_out, dropout)

    def forward(self, x: torch.Tensor, context: torch.Tensor | None = None) -> torch.Tensor:
        hidden = self.fc1(x)
        if context is not None and self.context is not None:
            hidden = hidden + self.context(context)
        hidden = self.fc2(F.elu(hidden))
        return self.gate(hidden, self.skip(x))


class VariableSelectionNetwork(nn.Module):
    """Learns a softmax weight per input variable (the TFT's feature importance).

    Each scalar variable is first embedded to ``d_model`` by its own linear map,
    then processed by its own GRN; the weighted sum is the selected input.
    """

    def __init__(self, n_vars: int, d_model: int, dropout: float, d_context: int | None = None):
        super().__init__()
        self.n_vars = n_vars
        self.embed_weight = nn.Parameter(torch.randn(n_vars, d_model) * 0.1)
        self.embed_bias = nn.Parameter(torch.zeros(n_vars, d_model))
        self.selector = GatedResidualNetwork(n_vars * d_model, d_model, n_vars, dropout, d_context)
        self.var_grns = nn.ModuleList(
            GatedResidualNetwork(d_model, d_model, d_model, dropout) for _ in range(n_vars)
        )

    def forward(self, x: torch.Tensor, context: torch.Tensor | None = None):
        # x: [..., n_vars]  ->  embeddings: [..., n_vars, d_model]
        emb = x.unsqueeze(-1) * self.embed_weight + self.embed_bias
        flat = emb.flatten(start_dim=-2)
        weights = torch.softmax(self.selector(flat, context), dim=-1)            # [..., n_vars]
        processed = torch.stack([grn(emb[..., i, :]) for i, grn in enumerate(self.var_grns)], dim=-2)
        selected = (weights.unsqueeze(-1) * processed).sum(dim=-2)              # [..., d_model]
        return selected, weights


class InterpretableMultiHeadAttention(nn.Module):
    """Multi-head attention whose heads share the value projection.

    Averaging the heads then yields a single, interpretable attention pattern
    over past time steps (eq. (14)-(16) of the paper).
    """

    def __init__(self, d_model: int, n_heads: int, dropout: float):
        super().__init__()
        self.d_head = d_model // n_heads
        self.q_proj = nn.ModuleList(nn.Linear(d_model, self.d_head) for _ in range(n_heads))
        self.k_proj = nn.ModuleList(nn.Linear(d_model, self.d_head) for _ in range(n_heads))
        self.v_proj = nn.Linear(d_model, self.d_head)
        self.out = nn.Linear(self.d_head, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, q, k, v, mask: torch.Tensor):
        values = self.v_proj(v)
        heads, attns = [], []
        for q_proj, k_proj in zip(self.q_proj, self.k_proj):
            scores = q_proj(q) @ k_proj(k).transpose(-2, -1) / math.sqrt(self.d_head)
            attn = torch.softmax(scores.masked_fill(mask, float("-inf")), dim=-1)
            attn = self.dropout(attn)
            heads.append(attn @ values)
            attns.append(attn)
        head = torch.stack(heads).mean(dim=0)
        return self.out(head), torch.stack(attns).mean(dim=0)


class MonotoneQuantileHead(nn.Module):
    """Maps hidden states to non-crossing quantiles around an anchor value.

    prediction[h, q] = anchor + step_scale[h] * z[h, q], where z is a monotone
    set of standardised quantiles. ``step_scale`` (a buffer, saved with the
    weights) is the spread of h-step changes in the training data; the bias is
    initialised to standard-normal quantiles, so the untrained head is a
    random walk with Gaussian intervals of the right width at every horizon.
    """

    def __init__(self, d_model: int, quantiles: list[float], horizon: int):
        super().__init__()
        self.median_idx = quantiles.index(0.5)
        self.fc = nn.Linear(d_model, len(quantiles))
        self.register_buffer("step_scale", torch.ones(horizon))

        z = torch.distributions.Normal(0.0, 1.0).icdf(torch.tensor(quantiles))
        gaps = torch.cat([z[1:self.median_idx + 1] - z[:self.median_idx],     # lower spacings
                          z[self.median_idx + 1:] - z[self.median_idx:-1]])   # upper spacings
        nn.init.normal_(self.fc.weight, std=0.01)
        with torch.no_grad():
            bias = torch.log(torch.expm1(gaps))                                # softplus^-1
            self.fc.bias.copy_(torch.cat([bias[:self.median_idx], torch.zeros(1), bias[self.median_idx:]]))

    def forward(self, h: torch.Tensor, anchor: torch.Tensor) -> torch.Tensor:
        raw = self.fc(h)
        m = self.median_idx
        median = raw[..., m:m + 1]
        upper = median + torch.cumsum(F.softplus(raw[..., m + 1:]), dim=-1)
        lower = median - torch.cumsum(F.softplus(raw[..., :m].flip(-1)), dim=-1).flip(-1)
        z = torch.cat([lower, median, upper], dim=-1)                          # [B, H, Q]
        return anchor + z * self.step_scale.view(1, -1, 1)


# ---------------------------------------------------------------------------
# The full model
# ---------------------------------------------------------------------------
class TemporalFusionTransformer(nn.Module):
    def __init__(
        self,
        n_categories: int,
        n_encoder_vars: int,
        n_decoder_vars: int,
        quantiles: list[float],
        horizon: int,
        hidden_size: int = 32,
        attention_heads: int = 4,
        dropout: float = 0.1,
    ):
        super().__init__()
        d = hidden_size
        self.quantiles = quantiles

        # Static covariate encoders -> context vectors (selection, enrichment, LSTM h0 / c0).
        self.static_embedding = nn.Embedding(n_categories, d)
        self.static_contexts = nn.ModuleList(GatedResidualNetwork(d, d, d, dropout) for _ in range(4))

        self.encoder_vsn = VariableSelectionNetwork(n_encoder_vars, d, dropout, d_context=d)
        self.decoder_vsn = VariableSelectionNetwork(n_decoder_vars, d, dropout, d_context=d)

        self.lstm_encoder = nn.LSTM(d, d, batch_first=True)
        self.lstm_decoder = nn.LSTM(d, d, batch_first=True)
        self.post_lstm_gate = GateAddNorm(d, d, dropout)

        self.static_enrichment = GatedResidualNetwork(d, d, d, dropout, d_context=d)
        self.attention = InterpretableMultiHeadAttention(d, attention_heads, dropout)
        self.post_attention_gate = GateAddNorm(d, d, dropout)
        self.positionwise_grn = GatedResidualNetwork(d, d, d, dropout)
        self.pre_output_gate = GateAddNorm(d, d, 0.0)
        self.head = MonotoneQuantileHead(d, quantiles, horizon)

    def forward(self, static, encoder_x, decoder_x, anchor):
        """
        static    : [B]            category index
        encoder_x : [B, L, n_enc]  past observed + known inputs
        decoder_x : [B, H, n_dec]  known-future inputs
        anchor    : [B]            last observed scaled premium
        returns   : dict with ``prediction`` [B, H, Q] plus interpretability tensors
        """
        L, H = encoder_x.shape[1], decoder_x.shape[1]

        s = self.static_embedding(static)
        c_select, c_enrich, c_h, c_c = (grn(s) for grn in self.static_contexts)

        enc_sel, enc_w = self.encoder_vsn(encoder_x, c_select.unsqueeze(1).expand(-1, L, -1))
        dec_sel, dec_w = self.decoder_vsn(decoder_x, c_select.unsqueeze(1).expand(-1, H, -1))

        state = (c_h.unsqueeze(0).contiguous(), c_c.unsqueeze(0).contiguous())
        enc_out, state = self.lstm_encoder(enc_sel, state)
        dec_out, _ = self.lstm_decoder(dec_sel, state)

        selected = torch.cat([enc_sel, dec_sel], dim=1)
        temporal = self.post_lstm_gate(torch.cat([enc_out, dec_out], dim=1), selected)   # [B, L+H, d]

        enriched = self.static_enrichment(temporal, c_enrich.unsqueeze(1).expand(-1, L + H, -1))

        # Decoder positions attend to the whole past and to earlier forecast steps only.
        query = enriched[:, L:]
        causal = torch.ones(H, L + H, dtype=torch.bool, device=query.device).triu(diagonal=L + 1)
        attn_out, attn = self.attention(query, enriched, enriched, causal)

        h = self.post_attention_gate(attn_out, query)
        h = self.positionwise_grn(h)
        h = self.pre_output_gate(h, temporal[:, L:])

        prediction = self.head(h, anchor.view(-1, 1, 1))
        return {
            "prediction": prediction,
            "encoder_weights": enc_w,
            "decoder_weights": dec_w,
            "attention": attn,
        }


def quantile_loss(prediction: torch.Tensor, target: torch.Tensor, quantiles: list[float]) -> torch.Tensor:
    """Pinball loss averaged over quantiles, horizons and the batch.

    prediction: [B, H, Q]; target: [B, H].
    """
    q = torch.tensor(quantiles, dtype=prediction.dtype, device=prediction.device)
    error = target.unsqueeze(-1) - prediction
    return torch.maximum(q * error, (q - 1) * error).mean()
