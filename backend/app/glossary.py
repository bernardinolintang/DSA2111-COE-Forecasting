"""Plain-language definitions of every concept the UI shows.

One source of truth for three consumers:
  * the "Explain this" popovers in the web app (GET /api/glossary),
  * the COE Analyst's system prompt (so it explains terms the way the app uses them),
  * the analyst's offline mode (answers "what does X mean?" without an LLM).

``simple`` is written for a first-time car buyer; ``technical`` is optional
detail for readers who want the statistics.
"""

from __future__ import annotations

from .config import settings


# this builds the terms inside a function so that the 8% threshold comes from the settings
def glossary() -> dict[str, dict]:
    t = round(settings.wait_threshold * 100)
    terms = [
        ("coe", "COE (Certificate of Entitlement)",
         "A COE is the right to own and use a vehicle in Singapore for 10 years. Supply is limited, so buyers "
         "bid for them in auctions held twice a month. The winning price is called the premium.",
         "Each quota quarter the Land Transport Authority (LTA) sets how many COEs are released per category, "
         "based on vehicle de-registrations. Results are published after each bidding exercise closes."),
        ("categories", "COE categories (Cat A–E)",
         "Cat A: small cars (up to 1,600cc and 97kW; EVs up to 110kW). Cat B: larger cars. Cat C: goods "
         "vehicles and buses. Cat D: motorcycles. Cat E: open – any vehicle except motorcycles, and it usually "
         "tracks Cat B.",
         "Cat E COEs can be used for any vehicle type except motorcycles, so its premium tends to follow the "
         "most expensive category it can substitute for, usually Cat B."),
        ("premium", "Premium",
         "The price everyone who wins a COE in that bidding exercise pays. It is set at the cut-off where the "
         "quota is filled, so it is the same for all winners, whatever they bid.",
         "COE bidding is a uniform-price (open) auction: bids are ranked from the highest down, the quota is "
         "filled from the top, and the cut-off price becomes the quota premium for every successful bidder."),
        ("quota", "Quota",
         "How many COEs are released in a bidding exercise. More COEs for the same number of bidders usually "
         "means a lower premium.",
         "Quotas are announced per quota quarter (six exercises: three months × two exercises)."),
        ("bids-per-coe", "Bids per COE",
         "Bids received divided by the quota. Above 1 means more people bid than there are COEs, which pushes "
         "the premium up.",
         "Also called demand pressure or the bid ratio. It is one of the observed inputs to the forecasting model."),
        ("median", "Median forecast",
         "The model's middle estimate: the premium is equally likely to end up above or below it. It is not a "
         "promise – look at the ranges to see how far it could move.",
         "The 50th percentile (p50) of the forecast distribution produced by the hybrid model."),
        ("range-50", "50% range",
         "The narrower shaded band. The model expects the premium to land inside it about half the time.",
         "The interval between the 25th and 75th percentiles (p25–p75) of the forecast distribution."),
        ("range-80", "80% range",
         "The wider shaded band. The model expects the premium to land inside it about 8 times out of 10, so "
         "roughly 1 time in 10 it ends up above, and 1 in 10 below. A wider band means more uncertainty.",
         "The interval between the 10th and 90th percentiles (p10–p90). In the out-of-sample backtest the app "
         "reports how often real results actually fell inside this range (interval coverage)."),
        ("horizon", "Forecast horizon",
         "How far ahead a forecast looks. The app forecasts the next six bidding exercises (one quota quarter). "
         "The further ahead, the wider the ranges, because more can change.",
         "Errors compound with the horizon: the model's error grows from about one exercise ahead to six ahead, "
         "as shown in the Model page's error-by-horizon chart."),
        ("outlook", "Market outlook",
         "Which way the forecast leans by the end of the next quota quarter, and how clearly: downward pressure, "
         "slight downward pressure, no clear direction, slight upward pressure or upward pressure. It describes "
         "the forecast. It is not advice to buy or to wait – that depends on your own situation, and the model "
         "only forecasts the COE premium, one part of the cost of a car.",
         "From the forecast distribution at the horizon: a direction is called 'slight' when P(lower) or "
         "P(higher) reaches 55% and clear when it reaches 65%; otherwise 'No clear direction'. COE premiums "
         "behave close to a random walk, so 'No clear direction' is the usual, honest result."),
        ("uncertainty", "Model uncertainty",
         "How wide the forecast's 80% range is compared with today's premium – low, moderate or high. High "
         "uncertainty means the premium could land a long way from the median, so treat the median as a rough "
         "centre rather than a prediction.",
         "Half the width of the 80% range (p10–p90) at the horizon, as a percentage of the latest premium: low "
         "below ±8%, moderate up to ±15%, high above that. A presentation rule, not part of the evaluated model."),
        ("prob-drop", f"Chance of a drop of {t}% or more",
         f"The probability that the premium at the end of the next quota quarter is at least {t}% below today's "
         f"– a fall big enough to make a real difference to what you pay.",
         f"P(premium_h ≤ premium_today × (1 − {t / 100:.2f})), read from the interpolated forecast CDF. {t}% is "
         f"the saving the project treats as meaningful."),
        ("supply-scenario", "Supply scenario",
         "A what-if for next quarter's quota: what the forecast looks like if LTA releases up to 20% more or "
         "fewer COEs than now. 'As announced' keeps the current quota. More supply usually means lower premiums.",
         "Quotas for the rest of the current quota quarter are the announced ones; the scenario multiplies the "
         "next quarter's quota, a known-future input to the Temporal Fusion Transformer. The model is run at "
         "−20%, −10%, 0, +10% and +20%; the Scenario Lab slider interpolates linearly between those runs."),
        ("pqp", "Prevailing Quota Premium (PQP)",
         "What you pay to renew an existing COE instead of bidding for a new one: the average of the premiums "
         "in your category over the last three months. Renewing for 10 years costs the full PQP; renewing for 5 "
         "years costs half, but that COE cannot be renewed again.",
         "The moving average of the quota premiums from the bidding exercises in the three months before the "
         "month of renewal. The app estimates it from published results; LTA publishes the official figure."),
        ("provenance", "Forecast details (data, model, time)",
         "Every forecast shows when it was produced, the last bidding exercise it includes, which model run "
         "made it and where the data came from – so you can tell how fresh it is and trace it back.",
         "The forecast ID combines the category, the first exercise forecast and the model run, e.g. "
         "A-2026-10-E1-r39. Each run and its forecasts are kept in the database, so past forecasts can be "
         "reproduced and audited."),
        ("win-probability", "Chance of winning",
         "The estimated probability that your bid is at or above the next premium, so you would win a COE. "
         "Bidding higher raises your chance but does not change what you pay: every winner pays the premium.",
         "P(win) = P(premium ≤ bid), read from the forecast CDF for the next exercise (uniform-price auction)."),
        ("reserve-price", "Reserve price (your bid)",
         "The most you are willing to pay. If the premium ends up below your bid you win and pay the premium; "
         "if it ends up above, you don't win. You commit to paying up to your bid if prices spike.",
         "Suggested reserve prices are forecast quantiles for the next exercise, e.g. the 90th percentile gives "
         "an estimated 90% chance of winning."),
        ("box-tiao", "Box-Tiao intervention analysis",
         "A way to measure how much a policy change (like loan curbs or a quota injection) moved premiums, after "
         "allowing for the market's normal ups and downs.",
         "For each category: y_t = Σ ω_k·I_k(t) + N_t on the Box-Cox-transformed premium, where I_k switches on "
         "when policy k takes effect and N_t is an ARIMA(p,1,q) noise process chosen by AIC. ω_k is converted "
         "into a percentage of the premium just before the event."),
        ("effect-types", "Permanent / temporary shift, one-off shock",
         "A permanent shift means the policy moved premiums to a new level that lasted. A temporary shift lasted "
         "only while the policy was in force. A one-off shock affected a single moment.",
         "Modelled as a step dummy (1 from the effective date onwards), a temporary step (1 between start and "
         "end dates) or a pulse (1 at a single exercise)."),
        ("significance", "Clear / unclear effect (statistical significance)",
         "A clear effect is too large to be normal price swings. An unclear one (not statistically significant, "
         "'n.s.') is within normal swings, so it could plausibly be zero: treat it as a rough indication only.",
         "p is the two-sided p-value of ω_k in the intervention model; significant when p < 0.05."),
        ("confidence-interval", "95% confidence interval",
         "The whiskers on each effect bar: the range of effect sizes that fit the data. If it crosses zero, the "
         "policy may have had no effect at all.",
         "ω_k ± 1.96 × standard error, converted to percentages. Overlapping events (e.g. 2013 and 2014) inflate "
         "the intervals because their effects are hard to separate."),
        ("backtest", "Out-of-sample backtest",
         "A fair test: the model forecasts periods it never saw during training, and those forecasts are "
         "compared with what actually happened.",
         "Rolling-origin evaluation over the last 72 exercises (3 years): re-forecast from every exercise, 1–6 "
         "steps ahead, using only data up to that point."),
        ("mape", "MAPE (average error)",
         "The typical size of the forecast error, as a percentage of the actual premium. For example, 5% would "
         "mean the median forecast was off by about 5% on average.",
         "Mean absolute percentage error of the median forecast: mean(|actual − q50| / actual)."),
        ("smape", "sMAPE",
         "Like MAPE, a percentage error, but measured against the average of the forecast and the actual, so "
         "over- and under-forecasts count more evenly.",
         "Symmetric MAPE: mean(2·|actual − q50| / (|actual| + |q50|)). Stored with the backtest metrics."),
        ("pinball", "Pinball loss",
         "A score for the whole forecast range, not just the middle guess, in dollars. Lower is better.",
         "Mean quantile (pinball) loss over p10, p50 and p90. It rewards ranges that are both accurate and "
         "appropriately narrow."),
        ("coverage", "Interval coverage",
         "How often the real premium actually fell inside the 80% range in the backtest. Close to 80% means the "
         "ranges are honest; much lower means the model is over-confident.",
         "Share of backtest actuals within [q10, q90]."),
        ("direction", "Direction accuracy",
         "When the model predicted a noticeable rise or fall, how often it got the direction right.",
         "Only forecasts calling a move of more than 0.5% are scored, so the random walk (which never calls a "
         "move) has no score."),
        ("random-walk", "Random walk baseline",
         "The simplest forecast: next premium = today's premium. COE prices are hard to predict, so this is a "
         "tough benchmark to beat.",
         "Intervals come from the empirical distribution of past h-step changes."),
        ("diebold-mariano", "Diebold–Mariano test",
         "Checks whether one model's forecasts are genuinely better than another's or just lucky. p < 0.05 means "
         "the difference is statistically significant.",
         "Compares per-origin percentage pinball loss between two models, with a Newey–West variance estimate."),
        ("hybrid", "Hybrid model (TFT + Box-Tiao ARIMAX)",
         "The app's forecasting model: an average of a deep-learning model (TFT) and a statistical model that "
         "knows about policy shocks. Blending the two is more reliable than either alone.",
         "Equal-weight average of the TFT's and the Box-Tiao ARIMAX's quantiles."),
        ("tft", "Temporal Fusion Transformer (TFT)",
         "A neural network designed for forecasting. It reads price history, bidding pressure, the economy and "
         "things known in advance (announced quotas, policies) and learns which of them matter.",
         "Variable selection networks, static covariate encoders, an LSTM encoder–decoder, interpretable "
         "multi-head attention and a monotone quantile head (p5…p95), trained on deviations from a random walk."),
        ("variable-importance", "Variable importance",
         "How much weight the TFT puts on each input when it forecasts. Higher means the model relies on it more "
         "– not necessarily that it causes prices to change.",
         "Averaged variable-selection-network weights over the last two years, for past inputs (encoder) and "
         "known-future inputs (decoder)."),
        ("attention", "Attention weights",
         "Which past bidding exercises the TFT 'looks back at' most when forecasting. A flat pattern means it "
         "uses the whole recent history rather than a few key moments.",
         "Average interpretable multi-head attention weight per lag (1 = the latest exercise)."),
        ("watchlist", "Watchlist",
         "Targets you're watching, like 'Cat A below $110,000'. After every bidding exercise each one is "
         "re-scored against the new forecast. You'll see the updated status the next time you open COE Compass "
         "– there are no emails or push messages.",
         "Stored in Postgres against a random browser ID; scored with the forecast CDF: the best chance over the "
         "next six exercises of crossing the target."),
    ]
    return {tid: {"id": tid, "term": term, "simple": simple, "technical": technical}
            for tid, term, simple, technical in terms}
