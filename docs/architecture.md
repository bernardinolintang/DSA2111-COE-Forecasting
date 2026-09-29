# System design

Material for report Section 3 (system design) and the presentation. Diagrams are Mermaid and
render directly on GitHub, or paste them into https://mermaid.live to export PNGs.

## 1. Deployment architecture

```mermaid
flowchart LR
    user([Browser]) -->|HTTP :8080 / NodePort 30080| web
    subgraph cluster[docker compose  /  microk8s namespace coe-g7]
        web[web<br/>nginx:alpine<br/>static SPA + reverse proxy]
        api[api ×2<br/>FastAPI + Uvicorn<br/>HPA 2–5 pods]
        db[(PostgreSQL 16<br/>PVC)]
        ml[ml<br/>Python + PyTorch<br/>Job + weekly CronJob]
        web -->|/api/*| api
        api -->|SQL read, alerts write| db
        ml -->|upsert data, write runs & forecasts| db
    end
    ml -->|REST| datagov[(data.gov.sg<br/>LTA COE results)]
    ml -->|REST| singstat[(SingStat<br/>CPI, SORA, GDP)]
```

Design choices:

* **Batch training, online serving.** Training and forecasting run as a batch job after each
  bidding exercise; the API only reads pre-computed forecasts. The API image therefore needs no
  PyTorch (≈290 MB instead of ≈1.9 GB), answers in milliseconds and scales horizontally.
* **Stateless API and web tiers** run 2+ replicas behind Services (self-healing, rolling updates
  with `maxUnavailable: 0`). The stateful database is a single replica with a persistent volume.
* **Schema as code.** `db/init.sql` is idempotent and applied by both the ML job and the API on
  start-up, so pods can start in any order.
* **Offline fallback.** A CSV snapshot of all raw data ships in the ML image, so a network failure
  or API change never blocks retraining.

## 2. ML pipeline

```mermaid
flowchart TD
    A[Ingest<br/>data.gov.sg + SingStat] --> B[Panel<br/>396 exercises × 5 categories]
    B --> C[Box-Cox + Min-Max target<br/>known / observed features]
    C --> D[Box-Tiao per category<br/>ARIMA errors, AIC, parallel]
    D -->|policy_effect, dummies| E[Windows<br/>24 past → 6 future exercises]
    E --> F[CV epoch selection<br/>3 rolling folds × 3 seeds, parallel]
    F --> G[Backtest 3 years<br/>TFT vs 6 baselines, DM tests]
    F --> H[Production TFT<br/>all data, 3-seed ensemble]
    H --> I[Forecasts × 5 supply scenarios<br/>p5 … p95]
    H --> J[Interpretability<br/>VSN weights, attention]
    D --> K[Policy effects %]
    G & I & J & K --> L[(PostgreSQL run)]
```

## 3. Temporal Fusion Transformer (as implemented in `ml/coe_ml/models/tft.py`)

```mermaid
flowchart TD
    s[category] --> se[Static covariate encoders<br/>4 GRNs]
    se -->|c_s| vsn1 & vsn2
    se -->|c_h, c_c| lstm1
    se -->|c_e| enr
    past[past inputs: premium, bids/quota,<br/>CPI, SORA, GDP + known inputs] --> vsn1[Variable selection]
    fut[known future: quota, calendar,<br/>policy dummies, Box-Tiao effect] --> vsn2[Variable selection]
    vsn1 --> lstm1[LSTM encoder] --> lstm2[LSTM decoder]
    vsn2 --> lstm2
    lstm1 & lstm2 --> gate[Gate + Add&Norm]
    gate --> enr[Static enrichment GRN]
    enr --> att[Interpretable multi-head attention<br/>causal mask]
    att --> ff[Position-wise GRN]
    ff --> head[Monotone quantile head<br/>anchor + scale_h × z]
    head --> out[p5 p10 p25 p50 p75 p90 p95<br/>for 6 exercises]
```

Differences from the original paper, and why:

| Change | Reason |
|---|---|
| Predict change from last premium (anchoring) | COE premiums are close to a random walk |
| Output scaled by the typical h-step move; head initialised at normal quantiles | An untrained network is a calibrated random walk, so training learns improvements on the strongest simple baseline |
| Monotone quantile head (median ± cumulative softplus) | No quantile crossing, so p10 ≤ p50 ≤ p90 always |
| Policy dummies switched off for events the training data cannot estimate | Prevents never-trained input weights from injecting noise when a new policy starts |

## 4. Evaluation protocol

* **Test period:** last 72 exercises (3 years). Nothing from it is used for fitting, scaling, the
  Box-Tiao estimates or choosing epochs.
* **Rolling origins:** a forecast is made from every exercise in the test period, 1–6 steps ahead,
  using only data up to that origin. Future quota follows the production rule: the announced quota
  for the rest of the current quota quarter, then persistence.
* **Epoch selection:** rolling time-series cross-validation with three one-year folds before the test
  period; learning curves are averaged over folds and seeds.
* **Metrics:** pinball loss (p10/p50/p90, in SGD), MAPE / MAE / RMSE of the median, 80% interval
  coverage, directional accuracy (only for forecasts calling a >0.5% move), plus Diebold–Mariano tests
  on per-origin percentage pinball loss with Newey–West variance.
* **Baselines:** random walk (empirical intervals), ARIMA, ARIMAX + Box-Tiao, gradient boosting
  (quantile loss), seq2seq LSTM, and the TFT without policy inputs (ablation).
* **Predictability check:** `ml/scripts/predictability.py` shows a linear model on momentum, demand
  pressure and quota changes explains only about 1–3% more variance than the random walk out of
  sample. That is the realistic ceiling for any model on this market.

## 5. REST API

| Method & path | Returns |
|---|---|
| `GET /api/health` | liveness/readiness, latest run |
| `GET /api/summary` | dashboard cards for all categories |
| `GET /api/history/{cat}?years=` | bidding results |
| `GET /api/forecast/{cat}?scenario=` | p5–p95 for the next 6 exercises |
| `GET /api/scenarios` | supply what-if scenarios |
| `GET /api/recommendation/{cat}` | buy/wait advice with confidence and reasons |
| `GET /api/bid-planner/{cat}?bid=` | win probability curve and suggested bids |
| `GET /api/policy/events` | events with Box-Tiao effects and CIs |
| `GET /api/model/metrics` | leaderboard, by horizon, by category |
| `GET /api/model/backtest/{cat}?model=&horizon=` | out-of-sample predictions vs actuals |
| `GET /api/model/interpretability` | TFT variable importance and attention |
| `GET /api/model/runs` | pipeline history |
| `GET/POST/DELETE /api/alerts` | anonymous price alerts |
| `GET /api/macro` | CPI inflation, SORA, GDP |

Interactive documentation (OpenAPI/Swagger) is served at `/api/docs`.
