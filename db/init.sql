-- =============================================================================
-- COE Forecasting — PostgreSQL schema
--
-- This file is the single source of truth for the database schema. It is run
-- automatically by the official postgres image on first start (mounted into
-- /docker-entrypoint-initdb.d) and by the Kubernetes postgres Deployment via a
-- ConfigMap. Every statement is idempotent so it can be re-applied safely.
--
-- Data flow:
--   ml pipeline  --writes-->  raw data, model runs, forecasts, diagnostics
--   api service  --reads--->  everything;  --writes--> price_alerts only
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Raw market data
-- ---------------------------------------------------------------------------

-- this holds one row per (bidding exercise, vehicle category) from LTA via data.gov.sg so that
-- every result is stored once
CREATE TABLE IF NOT EXISTS coe_results (
    id              SERIAL PRIMARY KEY,
    month           DATE        NOT NULL,              -- first day of the bidding month
    bidding_no      SMALLINT    NOT NULL CHECK (bidding_no IN (1, 2)),
    category        CHAR(1)     NOT NULL CHECK (category IN ('A','B','C','D','E')),
    quota           INTEGER     NOT NULL,
    bids_success    INTEGER     NOT NULL,
    bids_received   INTEGER     NOT NULL,
    premium         INTEGER     NOT NULL,              -- quota premium in SGD
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (month, bidding_no, category)
);
-- this speeds up reads by category and date so that history queries stay fast
CREATE INDEX IF NOT EXISTS ix_coe_results_cat_month ON coe_results (category, month, bidding_no);

-- this holds monthly macro indicators from SingStat so that the pipeline can read them with the COE
-- data
CREATE TABLE IF NOT EXISTS macro_indicators (
    month       DATE             NOT NULL,
    indicator   TEXT             NOT NULL,   -- e.g. cpi_all_items, sora_3m, gdp_real
    value       DOUBLE PRECISION NOT NULL,
    source      TEXT             NOT NULL,
    PRIMARY KEY (month, indicator)
);

-- this holds the policy shocks used by the Box-Tiao model so that the Policy Lab can list them
CREATE TABLE IF NOT EXISTS policy_events (
    code            TEXT PRIMARY KEY,
    name            TEXT    NOT NULL,
    effective_month DATE    NOT NULL,
    end_month       DATE,                          -- only for 'temporary' events
    kind            TEXT    NOT NULL CHECK (kind IN ('step', 'pulse', 'temporary')),
    categories      TEXT    NOT NULL,              -- affected categories, e.g. 'ABE'
    description     TEXT    NOT NULL,
    source_url      TEXT
);

-- ---------------------------------------------------------------------------
-- 2. Model outputs
-- ---------------------------------------------------------------------------

-- each run of the ML pipeline creates one row, the API serves the latest run with status succeeded
-- so that a half-finished run is never shown
CREATE TABLE IF NOT EXISTS model_runs (
    id            SERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    status        TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed')),
    model_name    TEXT        NOT NULL,
    data_through  DATE,                       -- month of the last observed exercise
    last_bidding  SMALLINT,                   -- bidding_no of the last observed exercise
    params        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    metrics       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    duration_s    REAL,
    host          TEXT,
    notes         TEXT
);

-- this holds Box-Tiao estimates, omega is the level shift in Box-Cox units and pct_effect the
-- percent change in the premium so that both the model and the page have what they need
CREATE TABLE IF NOT EXISTS intervention_effects (
    run_id      INTEGER NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
    event_code  TEXT    NOT NULL REFERENCES policy_events(code) ON DELETE CASCADE,
    category    CHAR(1) NOT NULL,
    omega       DOUBLE PRECISION NOT NULL,
    std_err     DOUBLE PRECISION,
    p_value     DOUBLE PRECISION,
    pct_effect  DOUBLE PRECISION NOT NULL,
    pct_low     DOUBLE PRECISION,
    pct_high    DOUBLE PRECISION,
    PRIMARY KEY (run_id, event_code, category)
);

-- this holds the probabilistic forecasts, one row per future exercise so that a scenario can be
-- read as a path
CREATE TABLE IF NOT EXISTS forecasts (
    run_id      INTEGER  NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
    category    CHAR(1)  NOT NULL,
    scenario    TEXT     NOT NULL DEFAULT 'base',
    step        SMALLINT NOT NULL,          -- 1 = next bidding exercise
    month       DATE     NOT NULL,
    bidding_no  SMALLINT NOT NULL,
    quota       INTEGER,                    -- quota assumed for this exercise
    q05 DOUBLE PRECISION NOT NULL,
    q10 DOUBLE PRECISION NOT NULL,
    q25 DOUBLE PRECISION NOT NULL,
    q50 DOUBLE PRECISION NOT NULL,
    q75 DOUBLE PRECISION NOT NULL,
    q90 DOUBLE PRECISION NOT NULL,
    q95 DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (run_id, category, scenario, step)
);

-- this holds rolling-origin accuracy for the TFT and every baseline so that the leaderboard can be
-- read straight from the table
CREATE TABLE IF NOT EXISTS backtest_metrics (
    run_id      INTEGER  NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
    model       TEXT     NOT NULL,
    category    CHAR(1)  NOT NULL,          -- '*' = all categories pooled
    horizon     SMALLINT NOT NULL,          -- 0 = all horizons pooled
    n           INTEGER  NOT NULL,
    mae         DOUBLE PRECISION,
    rmse        DOUBLE PRECISION,
    mape        DOUBLE PRECISION,
    smape       DOUBLE PRECISION,
    pinball     DOUBLE PRECISION,           -- mean quantile loss (SGD)
    coverage80  DOUBLE PRECISION,           -- share of actuals inside [q10, q90]
    direction   DOUBLE PRECISION,           -- directional accuracy vs. origin
    PRIMARY KEY (run_id, model, category, horizon)
);

-- this holds each backtest prediction so that the "predicted vs actual" chart can be drawn
CREATE TABLE IF NOT EXISTS backtest_predictions (
    run_id      INTEGER  NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
    model       TEXT     NOT NULL,
    category    CHAR(1)  NOT NULL,
    origin      INTEGER  NOT NULL,          -- time index of the forecast origin
    horizon     SMALLINT NOT NULL,
    month       DATE     NOT NULL,
    bidding_no  SMALLINT NOT NULL,
    actual      DOUBLE PRECISION NOT NULL,
    q10         DOUBLE PRECISION,
    q50         DOUBLE PRECISION NOT NULL,
    q90         DOUBLE PRECISION,
    PRIMARY KEY (run_id, model, category, origin, horizon)
);

-- this holds the TFT variable-selection weights so that the model page can show what the model
-- looks at
CREATE TABLE IF NOT EXISTS variable_importance (
    run_id      INTEGER NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
    component   TEXT    NOT NULL CHECK (component IN ('static', 'encoder', 'decoder')),
    variable    TEXT    NOT NULL,
    importance  DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (run_id, component, variable)
);

-- this holds attention by lag so that the model page can show which past exercises mattered
CREATE TABLE IF NOT EXISTS attention_weights (
    run_id      INTEGER  NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
    category    CHAR(1)  NOT NULL,
    lag         SMALLINT NOT NULL,          -- how many exercises back from the origin
    weight      DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (run_id, category, lag)
);

-- ---------------------------------------------------------------------------
-- 3. User data (written by the API)
-- ---------------------------------------------------------------------------

-- this holds anonymous price alerts, client_id is a random UUID made in the browser so that no
-- personal data is stored
CREATE TABLE IF NOT EXISTS price_alerts (
    id          SERIAL PRIMARY KEY,
    client_id   UUID        NOT NULL,
    category    CHAR(1)     NOT NULL CHECK (category IN ('A','B','C','D','E')),
    direction   TEXT        NOT NULL CHECK (direction IN ('below', 'above')),
    target      INTEGER     NOT NULL CHECK (target > 0),
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- this speeds up reads by client so that the watchlist loads fast
CREATE INDEX IF NOT EXISTS ix_price_alerts_client ON price_alerts (client_id);
