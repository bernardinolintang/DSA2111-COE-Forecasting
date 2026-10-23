# COE Compass: brand, trust and decision workflow

What changed in the third iteration of the web app, why, and how to run and test it.
The earlier iteration (analyst, tour, UX fixes) is described in `analyst-and-onboarding.md`.

The aim of this iteration: the app could already forecast, but it read as an analytics
dashboard. It now reads as a product with a name, a purpose and a workflow that starts from
what a visitor wants to do.

> **Before:** "We built a machine-learning dashboard that predicts COE."
> **Now:** "COE Compass turns Singapore's COE data into understandable forecasts, uncertainty
> and planning tools that help people make sense of an expensive, difficult decision."

## 1. Brand and design system

| Element | Choice |
|---|---|
| Name and line | **COE Compass**. *Understand the market. Plan your next move.* |
| Mark | A "C" with a compass needle through its opening (`frontend/public/assets/icon.svg`) |
| Colours | Deep navy `#0B1F33` (brand, text), teal `#087F7A` (actions, links, the forecast), amber `#E69B25` (attention, upward pressure), off-white page. Dark theme designed separately. All are tokens at the top of `css/styles.css` |
| Type | Inter, 16px body |
| Character | Calm, analytical, conservative: flat surfaces with hairline borders, 8–16px corners, no gradients or glass |

It borrows the qualities of a good public digital service (clear, accessible, evidence-based)
without imitating a government site. The footer, the About page and the analyst all state that
COE Compass is independent and not affiliated with LTA.

Text contrast was checked against WCAG AA for both themes (body and captions ≥ 4.5:1; white on
teal buttons 4.9:1; dark text on the lighter teal in dark mode).

## 2. Navigation

`Overview · Forecast · Plan · Explore · Learn`, with `Ask Compass` on the right.

| Section | Pages (tabs under the header) |
|---|---|
| Plan | My plan (`#/plan`), Bid planner (`#/bid/A`), Watchlist (`#/alerts`) |
| Explore | Scenario Lab (`#/scenario/A?quota=12`), Policy Lab (`#/policy/B`) |
| Learn | COE guide (`#/learn`), How it works (`#/learn/how`), Model performance (`#/model`), Data sources (`#/learn/sources`), FAQ and help (`#/learn/faq`), About (`#/learn/about`) |

Section tabs keep the category being viewed. Old `#/forecast/A?scenario=quota_plus_10` links
are redirected to the Scenario Lab.

A **market status bar** sits above the navigation on every page: the latest premium and change
for Cat A–E (each links to its forecast), the next exercise, when the forecast was last updated
(SGT) and the data source.

## 3. Outlook instead of Buy / Wait

The app used to say "Buy now", "Lean buy", "Wait" or "Lean wait". That is a strong
recommendation resting on a forecast of one cost component, and across 335 out-of-sample
forecasts the rule produced "Buy now" every time. It was replaced by a **market outlook** that
describes the forecast and leaves the decision to the reader (`backend/app/services/recommendation.py`):

| Outlook | When (forecast at the end of the next quota quarter) |
|---|---|
| Downward pressure | P(premium lower than today) ≥ 65% |
| Slight downward pressure | P(lower) ≥ 55% |
| No clear direction | neither side reaches 55% |
| Slight upward pressure | P(higher) ≥ 55% |
| Upward pressure | P(higher) ≥ 65% |

Shown with it: the median change, the chance of a drop of 8% or more (the proposal's
"worth waiting for" saving, kept as evidence rather than as a call), **model uncertainty**
(half-width of the 80% range against today's premium: low < ±8%, moderate ≤ ±15%, high above)
and the **drivers** (demand: bids per COE against its one-year average; supply: quota against a
year ago). The thresholds are presentation rules, not part of the evaluated model.

API changes (`/api/summary`, `/api/recommendation/{cat}`): `action`, `headline`, `conviction`,
`confidence_pct` and `prob_save_pct` are gone; `outlook`, `label`, `direction`, `strength`,
`prob_drop_pct`, `meaningful_drop`, `uncertainty`, `uncertainty_pct`, `drivers`, `next_label`
and `next_q10/q50/q90` are new. The analyst's prompts and basic mode follow the same wording
and are told never to advise buying or waiting; "should I buy or wait?" gets the evidence and
a plain statement that the model forecasts only the COE premium.

## 4. What each page gained

- **Overview**: a hero that says what the product is, "What are you planning?" (buying,
  renewing, bidding, exploring), then *Today's COE market*: each card reads current premium →
  next-exercise forecast and likely range → outlook → why (driver chips). The forecast chart
  follows, then the five-step "how forecasts are made" and the out-of-sample numbers.
- **Forecast chart**: recorded premium solid, median forecast dashed, 50% and 80% ranges
  shaded, a tick per forecast exercise, policy events marked when the history window includes
  them, and a tooltip with the median and both ranges.
- **Scenario Lab**: a slider from −20% to +20%. The model is run at −20, −10, 0, +10 and +20;
  all five runs are loaded once, so dragging needs no requests, and points in between are a
  straight line between the two nearest runs (`js/forecast-math.js`). The API interpolates the
  same way for `?quota_pct=` (`backend/app/services/scenarios.py`), and an end-to-end test
  checks the two agree. Nothing is extrapolated beyond the modelled range, and interpolated
  points are labelled as such.
- **Bid planner**: a sentence saying where the bid sits ("$2,800 above our median forecast,
  inside the model's 80% range, where the result is hardest to call"), and *Explore nearby
  bids* with the chance at round bids either side.
- **My plan**: buying or renewing, category, timing and an optional COE budget, kept in
  `localStorage` only. The result shows the outlook, the forecast range for that timing, the
  chance the premium is at or below the budget (next exercise and end of quarter), and a level
  to watch that can be added to the watchlist with one click. For renewals it estimates the
  **PQP** (average premium of the exercises in the three months before the month of renewal),
  using recorded results where they exist and the median forecast for exercises not yet held,
  and labels which is which.
- **Learn**: three kinds of help kept apart: how COE works, how COE Compass works, and how to
  use each tool; plus data sources and About / privacy. Live facts (data through, model run,
  coverage) are filled in from the API, and each section still renders without them.
- **Provenance**: every forecast carries *Last updated (SGT) · Data through · Model run ·
  Forecast ID · Source*, with a link to the data sources. The forecast ID
  (`A-2026-10-E1-r39` = category, first exercise forecast, model run) points at a run stored
  in Postgres, so a published forecast can be reproduced.
- **States**: a notice replaces a blank chart. If the forecast service is down while the
  history is reachable, Forecast, Overview and My plan keep the recorded results on screen
  with "Latest forecast temporarily unavailable … Last successful update: …" and a *Try again*
  button. This is also what a Kubernetes pod restart looks like from the browser.

## 5. Tests

```bash
docker compose run --rm --no-deps api pytest -q tests   # 73: outlook rules, interpolation, analyst, API
cd frontend && npm run test:unit                        # 21: forecast maths, PQP, routes, formatting
ANALYST_ENABLED=false docker compose up -d --no-deps api   # deterministic analyst for e2e
npx playwright test                                     # 79 end-to-end tests against http://localhost:8080
docker compose up -d --no-deps api                      # back to the configured analyst
```

`ANALYST_ENABLED` is now passed through `docker-compose.yml`. Two analyst e2e tests that check
exact wording skip themselves when a language model is active.

New end-to-end coverage: five-item navigation and section tabs; status bar on every page; home
page intents and cards (and no "Buy now" anywhere); outlook card with its evidence; forecast
details and IDs; the forecast-unavailable state and recovery; slider agrees with the API and
makes no requests while dragging; bid explanation and nearby bids; My plan (budget, timing,
persistence, PQP, watch level saved only on click); every Learn section; footer links; no
horizontal overflow at 375–1440px on all 14 routes.

## 6. Limitations and next steps

- The **PQP** is an estimate from published results; LTA's official figure may differ by
  rounding, and the page says so.
- "**Next exercise**" is a label (e.g. "Oct 2026 · 1st"), not a countdown: the app does not hold
  LTA's bidding calendar, so it does not claim a number of days.
- The **watchlist** still cannot notify anyone who does not have the site open (no accounts, no
  email or push channel). Web Push or opt-in email is the next step.
- My plan stays in one browser. Syncing it would need accounts.
- The audit trail covers the model run and forecast ID; dataset versioning (a hash of the
  ingested data per run) is not stored yet.
- The course report and the slide deck were written for the previous name and the Buy / Wait
  wording, and their screenshots predate this iteration.
