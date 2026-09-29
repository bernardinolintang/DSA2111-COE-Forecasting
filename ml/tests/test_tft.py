"""Unit tests for the from-scratch Temporal Fusion Transformer."""

import torch

from coe_ml.config import QUANTILES
from coe_ml.models import Seq2SeqLSTM, TemporalFusionTransformer, quantile_loss

B, L, H, N_ENC, N_DEC = 4, 12, 6, 7, 5


def make_inputs(seed: int = 0):
    g = torch.Generator().manual_seed(seed)
    return (torch.randint(0, 5, (B,), generator=g), torch.randn(B, L, N_ENC, generator=g),
            torch.randn(B, H, N_DEC, generator=g), torch.rand(B, generator=g))


def make_tft() -> TemporalFusionTransformer:
    torch.manual_seed(0)
    model = TemporalFusionTransformer(5, N_ENC, N_DEC, QUANTILES, H, hidden_size=16, attention_heads=4, dropout=0.0)
    return model.eval()


def test_output_shapes():
    out = make_tft()(*make_inputs())
    assert out["prediction"].shape == (B, H, len(QUANTILES))
    assert out["encoder_weights"].shape == (B, L, N_ENC)
    assert out["decoder_weights"].shape == (B, H, N_DEC)
    assert out["attention"].shape == (B, H, L + H)


def test_variable_selection_weights_are_distributions():
    out = make_tft()(*make_inputs())
    assert torch.allclose(out["encoder_weights"].sum(-1), torch.ones(B, L), atol=1e-5)
    assert torch.allclose(out["attention"].sum(-1), torch.ones(B, H), atol=1e-5)


def test_quantiles_never_cross():
    pred = make_tft()(*make_inputs())["prediction"]
    assert (pred.diff(dim=-1) >= 0).all()


def test_attention_is_causal():
    """Changing a later known input must not change earlier forecast steps."""
    model = make_tft()
    static, enc, dec, anchor = make_inputs()
    base = model(static, enc, dec, anchor)
    dec2 = dec.clone()
    dec2[:, -1] += 5.0
    changed = model(static, enc, dec2, anchor)
    assert torch.allclose(base["prediction"][:, :-1], changed["prediction"][:, :-1], atol=1e-5)
    assert not torch.allclose(base["prediction"][:, -1], changed["prediction"][:, -1])
    assert torch.all(base["attention"][:, 0, L + 1:] == 0)     # step 1 cannot see steps 2..H


def test_quantile_loss_matches_definition():
    pred = torch.tensor([[[1.0, 2.0, 3.0]]])
    target = torch.tensor([[2.5]])
    q = [0.1, 0.5, 0.9]
    expected = (0.1 * 1.5 + 0.5 * 0.5 + (0.9 - 1) * -0.5) / 3
    assert torch.isclose(quantile_loss(pred, target, q), torch.tensor(expected))


def test_tft_can_overfit_a_tiny_batch():
    torch.manual_seed(0)
    model = TemporalFusionTransformer(5, N_ENC, N_DEC, QUANTILES, H, hidden_size=16, dropout=0.0)
    static, enc, dec, anchor = make_inputs()
    target = anchor[:, None] + torch.linspace(0, 0.5, H)
    opt = torch.optim.Adam(model.parameters(), lr=1e-2)
    first = None
    for _ in range(150):
        loss = quantile_loss(model(static, enc, dec, anchor)["prediction"], target, QUANTILES)
        first = first or float(loss)
        opt.zero_grad()
        loss.backward()
        opt.step()
    assert float(loss) < 0.2 * first


def test_lstm_baseline_shapes():
    model = Seq2SeqLSTM(5, N_ENC, N_DEC, QUANTILES, H, hidden_size=8).eval()
    assert model(*make_inputs())["prediction"].shape == (B, H, len(QUANTILES))
