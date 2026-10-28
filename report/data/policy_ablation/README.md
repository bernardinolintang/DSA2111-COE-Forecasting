# Policy ablation results

Do the policy inputs improve the forecast? Each folder compares a model with and without them
over the same 3-year backtest (offline data snapshot, data through Sept 2026). Section IV-D of
the report uses all four.

| Folder | Models compared | Training |
|---|---|---|
| `tft_fixed2` | TFT vs TFT without policy inputs | both 2 epochs, 3 seeds |
| `tft_fixed3` | TFT vs TFT without policy inputs | both 3 epochs, 3 seeds |
| `tft_fixed4` | TFT vs TFT without policy inputs | both 4 epochs, 3 seeds |
| `arima_run1` | ARIMA vs ARIMAX + Box-Tiao dummies | 1 seed |

The TFT runs force the same epoch count on both models, so the only difference is the policy
inputs. Produced by `ml/scripts/tft_ablation.py --epochs N` and `ml/scripts/arima_ablation.py`;
`dm.csv` in each folder comes from `ml/scripts/dm_ablation.py`.
