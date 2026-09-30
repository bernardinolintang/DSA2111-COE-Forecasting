# COE Analyst, onboarding and UX fixes

What changed in the second iteration of the web app, why, and how to run and test it.

## 1. Audit findings and root causes

| Issue | Root cause | Fix |
|---|---|---|
| Bid planner "Chance of winning" chart blank at first | `lineChart()` never drew when created: it waited for the ResizeObserver's first callback, which then deferred again with `requestAnimationFrame`. The card was always painted at least once with an empty, default-height (150px) SVG; under load (first visit, screen recording) that blank state lasted long enough to see. Every slider movement then destroyed and rebuilt the whole chart, repeating the blank frame and a 150→280px height jump. | Charts draw synchronously on creation, redraw in place through `chart.update()`, redraw on resize only when the width changed, and cancel pending frames on `destroy()`. The bid page creates its chart once and only moves the marker. A test checks the curve is already present at the moment the SVG is inserted. |
| Stale forecast after quickly changing supply scenario | `update()` had no ordering: a slower response for an older scenario could arrive last and overwrite the newer one. | Each update is tagged; late responses are discarded (forecast, Policy Lab, Model backtest). |
| A page could be overwritten by the previous page | Every page rendered into the shared `#app` element, so a page still awaiting data when the viewer navigated away could write into the next page. | The router renders each navigation into a fresh container; old pages write into their own detached container. |
| Watchlist target accepted "d" | The only check ran on submit (`Number(value.replace(/[^0-9.]/g, ""))`), and the button was always enabled. | `parseMoney()` accepts `100000`, `100,000`, `$100,000`, `95k`; rejects letters, NaN, negatives, zero and blanks with an inline message; the button stays disabled until valid. |
| "Tell me when it's time" but nothing tells you | Alerts were stored and scored, but there is no email, SMS or push channel, so users were never notified. | Renamed to **Watchlist** with honest copy. Changes since the last visit are flagged (badge + notice), with an opt-in browser notification while a tab is open. Duplicates are rejected (409) and removal asks for confirmation. |
| "Buy now" shown with 48–54% "confidence" for every category | Not a bug in the rule: across 335 out-of-sample forecasts the 6-step median was never 8% below the origin (min −2.2%), because premiums are close to a random walk. But "confidence" was P(price higher), which is ~50% for a flat forecast, so the UI paired a confident label with a coin-flip number. | The action is unchanged. It is now worded by **conviction** (Buy now / Lean buy / Wait / Lean wait), and the card shows two labelled probabilities: chance prices are higher, and chance waiting saves ≥ 8% (the probability the rule is about). |
| Mobile (375px): theme toggle pushed off-screen | The `<nav>` flex item had no `min-width: 0`, so the scrollable link strip never scrolled and the header grew to 571px. | `nav { flex: 1; min-width: 0 }`; checked at 375/768/1024/1440px. |
| Small captions hard to read | `.tiny` used `--ink-3` (#86868b) at 12px: 3.7:1 on white, below WCAG AA. | Captions use 13px and a darker token (≈5:1 light, ≈5.9:1 dark). |
| Theme toggle reset the page | The toggle re-ran the router (scroll to top, scenario lost) although charts use CSS variables. | Theme switches without re-rendering. |
| Web container always "unhealthy" | `wget http://localhost/` resolves to `::1` in Alpine, but nginx listens on IPv4 only. | Healthcheck uses `127.0.0.1`. |
| Pipeline run stuck as "running" | An interrupted ML run never gets a finish time. | Shown as "interrupted" after 3 hours. |

## 2. COE Analyst architecture

- **Entry point:** "Ask COE Analyst" button on every page opens a side panel; the page stays visible (desktop content shifts left on wide screens).
- **Context, not scraping:** each page publishes identifiers through `frontend/public/js/context.js` (page, category, scenario, bid, event) plus display facts for the panel header. The browser sends only the identifiers; `backend/app/services/analyst/context.py` rebuilds every number from Postgres with the same services the pages use: all categories (latest result, forecast, recommendation with conviction and probabilities, bid suggestions), the focused category's forecast for the chosen scenario, bid odds, policy effects with CIs and p-values, model accuracy, and the viewer's watchlist.
- **Three modes, picked from the key in `.env`:**
  - *Groq* (`GROQ_API_KEY` set): `services/analyst/groq_llm.py` streams a chat completion (`openai/gpt-oss-120b` by default) with tool calling. Groq's free tier allows 8K tokens a minute, so this path uses a compact prompt (rules only; definitions via an `explain_term` tool, short tool descriptions) and compact app data (`context.compact`: full detail for the category in view, one line for the others): about 3.6–3.9K tokens for the first request instead of 8.4K. A follow-up request after a tool result leaves out the app data (the tool result and current view are enough), so a question that needs a calculation still fits the free budget. Verified against the live API: a bid question made two requests and answered in about 2 s.
  - *Claude* (`ANTHROPIC_API_KEY` set): `services/analyst/llm.py` calls Claude (`claude-opus-5-5` by default) with a static system prompt (rules + the app glossary, prompt-cached), the shared app data (cached until the next model run) and the current view. `fallbacks: "default"` (server-side refusal fallback beta) is enabled.
  - In both, server-side **data tools** compute bid odds, the bid for a target chance, other scenarios, target odds and history summaries, so the model never interpolates numbers itself. Refusals, rate limits, timeouts and API errors fall back to basic mode with a notice.
- **Streaming:** `POST /api/analyst/chat?stream=1` returns Server-Sent Events (`status` → "Thinking…", "Working out your chance of winning…"; `delta` → text; `done` → actions and provenance). The panel shows a "Thinking…" bubble (with tool progress), then the text exactly as it streams in, with no typewriter effect; nginx passes the stream through unbuffered.
  - *Basic mode* (no key, or LLM unavailable): `services/analyst/offline.py` handles navigation, scenarios, bid maths, watchlist drafts, "why Buy now?", "how certain?", biggest policy effect, quota effects and glossary questions deterministically, and says plainly what it cannot answer.
- **Controlled actions:** an explicit whitelist in `services/analyst/actions.py`: `navigate`, `set_supply_scenario`, `set_bid_amount`, `highlight`, `open_tutorial`, `prepare_watch`, `prepare_remove_watch`. Every action is validated on the server. Safe ones run in the browser (in place when the page supports it, otherwise via the URL). Watchlist changes come back with `confirm: true` and are shown as a card with **Confirm / Cancel**; nothing is saved until the user clicks.
- **Honesty:** the prompt requires every COE figure to come from the app data or a tool, and each statement to be labelled as recorded fact, model forecast or general information. Every answer shows a deterministic provenance line ("Based on Cat A forecast, results through the Sep 2026 · 2nd bidding exercise · model run #36…"). The panel keeps the "not financial advice" line.
- **Safety and cost:** the key lives only in the API container; questions are capped at 1,000 characters, history at 12 turns, and 30 questions per client per 10 minutes; nginx allows 90 s for `/api/analyst/`.

## 3. Tutorial and help

- First visit shows "New to COE Forecast? Take a 2-minute tour." (never forced). Only `coe-tour-seen` is stored.
- Seven steps with spotlight, Back / Next / Skip, "Step n of 7", Escape to leave, focus kept in the card:
  1. Overview cards → 2. Forecast chart (actual, median, 50%/80% ranges) → 3. Supply scenarios → 4. Bid planner → 5. Policy Lab → 6. Model trust summary → 7. Watchlist → *Finish and ask the COE Analyst anything*.
- The **?** button in the header reopens the tour, opens the analyst, or shows the full glossary.
- **Explain this (i)** buttons sit beside difficult terms (signal, conviction, median, 50%/80% range, supply scenario, reserve price, chance of winning, permanent shift, n.s., confidence interval, Box-Tiao, MAPE, sMAPE, pinball, coverage, direction, Diebold–Mariano, random walk, TFT variable importance, attention…). Each popover gives a plain explanation, optional technical detail and "Ask the analyst about this". Definitions come from `backend/app/glossary.py` (`GET /api/glossary`), shared with the analyst.

## 4. Setup

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | empty | Enables the Groq-backed analyst. Server-side only. |
| `ANTHROPIC_API_KEY` | empty | Enables the Claude-backed analyst. With both keys, Groq is used unless `ANALYST_PROVIDER` says otherwise. No key = basic mode. |
| `ANALYST_PROVIDER` | empty (auto) | `groq` or `anthropic` to force one. |
| `ANALYST_MODEL` | provider default | Groq: `openai/gpt-oss-120b` (also `llama-3.3-70b-versatile`, `openai/gpt-oss-20b`); Claude: `claude-opus-5-5`. |
| `ANALYST_EFFORT` | empty (model default) | `low` / `medium` / `high` reasoning effort; lower is faster and cheaper. |
| `ANALYST_TIMEOUT_S` | `45` | Budget per question across the tool loop. |
| `ANALYST_RATE_LIMIT` | `30` | Questions per client per 10 minutes (per API worker). |
| `ANALYST_ENABLED` | `true` | Set `false` to force basic mode. |

Docker Compose reads these from `.env` in the repository root, e.g. a one-line `.env` containing `GROQ_API_KEY=gsk_...`, then `docker compose up -d api` (no rebuild needed). `GET /api/analyst/status` shows the active provider and model, and the panel header shows "AI · Groq". On Kubernetes, `GROQ_API_KEY=… bash scripts/ronin/deploy.sh` stores the key in the `coe-analyst` Secret (optional; without it the API runs in basic mode).

## 5. Tests

```bash
docker compose run --rm api pytest -q tests      # backend: unit + integration against the live database
cd frontend && npm install
npm run test:unit                                 # parseMoney, routes, plain-language policy text, reply escaping, tour steps
npx playwright test                               # end-to-end against http://localhost:8080 (E2E_BASE_URL to change)
```

End-to-end coverage maps to the acceptance criteria: every forecast category loads; the bid chart is drawn in the frame it is inserted for all five categories; category and scenario changes leave no stale values (including a deliberately slowed older response); slider, typed bid, probability and marker stay in sync; invalid watchlist targets cannot be submitted, valid ones are normalised, duplicates are blocked in the form and by the API; the tour starts, skips, completes and reopens; the analyst receives the right view; navigation actions route correctly; watchlist changes need Confirm; an analyst outage leaves the app working; no console errors on the main journey; no horizontal overflow at 375–1440px; Back restores scroll.

## 6. Limitations and next steps

- **No off-site notifications.** The watchlist can only flag changes while the site is open. Real alerts need a delivery channel: Web Push (service worker + VAPID keys + a send step after each ML run) or opt-in email/Telegram.
- **The Groq and Claude paths are unit-tested with scripted fake clients, not against the live APIs** in this environment (no key was available). Ask a few real questions after setting the key.
- On Groq's free tier (8K tokens a minute) one question fits, but asking several within a minute (or running the e2e suite, whose real-backend tests call the analyst) can hit the rate limit; the panel then shows a basic-mode answer with a notice. For deterministic, quota-free e2e runs, start the API with `ANALYST_ENABLED=false`. The backend integration tests already force basic mode.
- The rate limit is in memory per API worker; replicas do not share it.
- The conviction thresholds (65% / 55%) are a presentation choice, not part of the evaluated model; the Wait rule itself is unchanged.
