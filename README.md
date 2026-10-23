# COE Forecast — Policy-Aware COE Forecasting with Temporal Fusion Transformers

DSA2111 Group 7 · National University of Singapore

A cloud-native web app that forecasts Singapore Certificate of Entitlement (COE)
premiums for all five categories. It combines **Box-Tiao intervention analysis**
(to measure policy shocks) with a **Temporal Fusion Transformer** (to forecast
with known-future inputs), and turns the probabilistic forecast into decisions:
a buy-or-wait signal, a bid planner and a price watchlist. A context-aware
**COE Analyst** and a guided tour explain every number to first-time buyers.

```
             ┌────────────────────────── docker compose / microk8s ──────────────────────────┐
 browser ──► │ web (nginx:alpine) ──/api──► api (FastAPI, 2 workers) ──► db (PostgreSQL 16)  │
             │   static SPA                   REST + OpenAPI docs          ▲                  │
             │                                                             │ writes           │
             │                       ml (Python + PyTorch, batch job) ─────┘                  │
             │                         data.gov.sg + SingStat ─► Box-Tiao ─► TFT ─► forecasts │
             └────────────────────────────────────────────────────────────────────────────────┘
```

## Features

| Page | What it does |
|---|---|
| **Overview** | Latest premium, change and buy/wait signal for Cat A–E worded by conviction (Buy now / Lean buy / Wait / Lean wait), with sparklines |
| **Forecast** | Fan chart (p10–p90) for the next six bidding exercises, supply what-if scenarios (±10/20% quota, kept in the URL), advice with conviction and the probabilities behind it, market pulse |
| **Bid planner** | Chance that a given reserve price clears the next exercise (uniform-price auction); slider, typed bid and chart stay in sync |
| **Policy Lab** | Eight policy shocks (2013 loan curbs → 2025 quota injection) explained in plain language, with Box-Tiao effects, 95% CIs and p-values under "Technical details" |
| **Model** | "Why should I trust this model?" summary, then the technical evaluation: leaderboard vs 7 other methods, Diebold-Mariano tests, error by horizon, predicted vs actual, TFT variable importance and attention |
| **Watchlist** | Anonymous target premiums stored in Postgres, re-scored against every new forecast; changes are flagged on the next visit (optional browser notification while a tab is open). No email/push channel, so it is not called an alert |
| **COE Analyst** | Side panel on every page that answers questions about the numbers on screen, opens pages, sets scenarios/bids and drafts watchlist targets (saved only after Confirm). Answers stream in as they are written. Uses Groq (`GROQ_API_KEY`) or Claude (`ANTHROPIC_API_KEY`) server-side, otherwise a deterministic basic mode |
| **Help** | Deterministic 7-step guided tour, "Explain this" (i) popovers on every technical term, and a glossary |

## Quick start (any laptop with Docker Desktop)

```bash
git clone <this repo> && cd DSA2111-COE-Forecasting
docker compose up --build          # first run trains the model (~10-15 min on a laptop)
```

Open **http://localhost:8080**. The API docs are at http://localhost:8080/api/docs.
Until the first `ml` run finishes, the pages show "No forecasts yet".

Useful commands:

```bash
docker compose logs -f ml                          # watch training
bash scripts/retrain.sh --quick                    # retrain + forecast after a new bidding exercise (~1 min)
bash scripts/retrain.sh                            # full run incl. backtest (~10-15 min)
docker compose run --rm api pytest -q tests        # API tests (unit + integration)
docker compose run --rm --entrypoint python ml -m pytest -q tests   # ML tests
cd frontend && npm install && npm test             # front-end unit tests + Playwright end-to-end (uses local Chrome)
bash scripts/backup_db.sh                          # pg_dump to backups/
```

## Deploying to the Ronin cloud VM (microk8s)

```bash
ssh exxxxxxx@dsa2111-semester1.nus.cloud
git clone <this repo> && cd DSA2111-COE-Forecasting
bash scripts/ronin/deploy.sh                       # build, push to localhost:32000, kubectl apply -k k8s/
# then, from your laptop:
ssh -L 8080:localhost:30080 exxxxxxx@dsa2111-semester1.nus.cloud   # open http://localhost:8080
```

`scripts/ronin/status.sh` shows pods and services, and can demo the Week 5 concepts live:
`status.sh heal` (delete a pod, watch it return), `status.sh scale 4`, `status.sh retrain`.

The VM disk is small and shared, so if the ML image (≈1 GB) does not fit, use
`SKIP_ML=1 bash scripts/ronin/deploy.sh` and train from a laptop through a tunnel to
the database, or load a `pg_dump` from `scripts/backup_db.sh`.

| Kubernetes object | Purpose |
|---|---|
| `Deployment coe-web` ×2 + NodePort 30080 | nginx front end |
| `Deployment coe-api` ×2 + HPA (2–5 pods at 70% CPU) | REST API, self-healing, autoscaling |
| `Deployment coe-db` + PVC | PostgreSQL with persistent storage |
| `Job coe-ml-initial` | trains the first model after deployment |
| `CronJob coe-ml-retrain` | retrains every Wednesday 17:30 SGT (after bidding closes) |

## How it maps to DSA2111

| Module topic | Where it is used |
|---|---|
| Cloud computing, Ronin VM, SSH / port forwarding | `scripts/ronin/*`, SSH tunnel to the NodePort |
| Processes & parallel computing (Week 2) | `ml/coe_ml/parallel.py`: Box-Tiao fits, ARIMA fits and neural-network seeds run in parallel worker processes; Uvicorn runs 2 worker processes |
| File system & bash scripting (Week 3) | `scripts/*.sh` (deploy, backup with rotation, retrain, cron) |
| Docker, Dockerfiles, Docker Hub (Week 4) | `*/Dockerfile`, `docker-compose.yml`, `nginx:alpine` front end, `scripts/push_dockerhub.sh` |
| Kubernetes / microk8s (Week 5) | `k8s/`: Deployments, Services, PVC, Job, CronJob, HPA, local registry `localhost:32000` |
| Data analytics & AI | `ml/`: ingestion, Box-Cox, Box-Tiao (statsmodels), TFT (PyTorch), backtesting |

## Repository layout

```
db/init.sql            PostgreSQL schema (single source of truth, applied idempotently)
ml/coe_ml/             ML pipeline package
  ingest.py            data.gov.sg + SingStat APIs, CSV snapshot fallback
  policy_events.py     the 8 policy interventions (dates verified against LTA / MAS)
  features.py          panel construction, Box-Cox target, known-future features
  interventions.py     Box-Tiao regression with ARIMA errors
  models/tft.py        Temporal Fusion Transformer, written from scratch in PyTorch
  models/lstm.py       seq2seq LSTM baseline
  baselines.py         random walk, ARIMA, ARIMAX + Box-Tiao, gradient boosting
  training.py          windows, training loop, ensembles
  evaluation.py        rolling-origin backtest, CV epoch selection, metrics, Diebold-Mariano
  pipeline.py          orchestration + database writes
ml/scripts/            tune.py (hyper-parameter sweeps), predictability.py (random-walk benchmark),
                       leakage_test.py (scrambles later data, checks earlier forecasts are unchanged),
                       fairness_stats.py (bootstrap CIs, calibration and error by horizon for a stored run)
backend/app/           FastAPI: routers/, services/ (SQL, quantile maths, advice, analyst/), glossary.py, schemas.py
frontend/public/       dependency-free SPA (ES modules, SVG charts), served by nginx
frontend/tests/        Node unit tests and Playwright end-to-end tests (dev tooling only)
k8s/                   microk8s manifests (kustomize)
scripts/               deployment and operations scripts
```

## Method in brief

1. **Data**: 1,980 bidding results (Jan 2010 → latest, 396 exercises × 5 categories) from the LTA dataset on
   data.gov.sg; CPI, 3-month compounded SORA and real GDP from SingStat, lagged by their publication delay.
2. **Target**: per-category Box-Cox transform then Min-Max scaling.
3. **Box-Tiao**: per category, `y_t = Σ ω_k I_k(t) + N_t` with `N_t ~ ARIMA(p,1,q)` (AIC-selected). Estimated
   shifts become the `policy_effect` known-future input; dummies of events not yet estimable are switched off.
4. **TFT**: variable selection networks, static covariate encoders, LSTM encoder–decoder, interpretable
   multi-head attention and a monotone quantile head (p5…p95). The head predicts deviations from a random
   walk scaled by the typical h-step move, so an untrained network is a calibrated random walk.
5. **Evaluation**: rolling-origin backtest over the last 72 exercises (3 years) re-forecasting at every
   exercise; epochs chosen by 3-fold rolling time-series CV inside the training period; pinball loss, MAPE,
   80% coverage, directional accuracy, and Diebold–Mariano tests vs every baseline.
6. **Decision layer**: “Wait” if the median one quota quarter ahead is ≥ 8% below today, otherwise “Buy now”;
   the call is worded by conviction (P(higher) ≥ 65% → Buy now, else Lean buy; P(waiting saves ≥ 8%) ≥ 65% →
   Wait, else Lean wait). Because premiums are close to a random walk the median rarely moves 8% in a quarter
   (it never did in the 3-year backtest), so a flat forecast shows as a low-conviction Lean buy rather than a
   strong Buy now. Bid win probability = P(premium ≤ bid) from the interpolated forecast CDF.

## Data sources

- COE bidding results: Land Transport Authority, via [data.gov.sg](https://data.gov.sg/datasets/d_69b3380ad7e51aff3a7dcc84eba52b8a/view) (Singapore Open Data Licence)
- CPI (M213751), interest rates (M700071), GDP (M015661): [SingStat Table Builder](https://tablebuilder.singstat.gov.sg)

No API keys are required. To give the COE Analyst a language model, create `.env` with `GROQ_API_KEY=...` (or
`ANTHROPIC_API_KEY=...`) and run `docker compose up -d api`; see `docs/analyst-and-onboarding.md`. A snapshot of all raw data is committed in `ml/data/snapshot/`
so the pipeline also runs offline (`python -m coe_ml run --offline`).
