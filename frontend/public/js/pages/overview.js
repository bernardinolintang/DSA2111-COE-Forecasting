// Home: hero, the five category cards, how it works, and honest headline numbers.

import { api } from "../api.js";
import { sparkline } from "../charts.js";
import { setView } from "../context.js";
import { explain } from "../glossary.js";
import { requestShared } from "../motion.js";
import { prefetch } from "./forecast.js";
import {
  CONVICTION, catColor, errorBox, html, money, moneyShort, mount, pct, raw, signalPill, timeAgo,
} from "../util.js";

function categoryCard(c) {
  const delta = c.change_pct;
  const dir = delta == null ? "flat" : delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
  const s = c.signal;
  return html`
    <a class="card cat-card" href="#/forecast/${c.code}" data-cat="${c.code}" aria-label="${c.name} forecast: ${s ? `${s.label}, ${CONVICTION[s.conviction]}` : "no forecast"}">
      <div class="cat-top">
        <span class="cat-chip"><span class="cat-swatch" style="background:${catColor(c.code)}"></span>${c.name}</span>
        ${signalPill(s)}
      </div>
      <div class="cat-name">${c.title}</div>
      <div>
        <div class="big-number">${money(c.latest.premium)}</div>
        <div class="delta ${dir}">${arrow} ${pct(delta)} <span class="muted small">vs last</span></div>
      </div>
      ${raw(sparkline(c.sparkline, c.horizon_q50 != null ? [c.next_q50, c.horizon_q50] : []))}
      <dl class="cat-stats">
        <div><dt>Median, ${c.horizon_label ? c.horizon_label.split(" · ")[0] : "—"}</dt><dd class="cat-median">${money(c.horizon_q50)}</dd></div>
        <div><dt>80% range</dt><dd>${c.horizon_q10 != null ? `${moneyShort(c.horizon_q10)}–${moneyShort(c.horizon_q90)}` : "—"}</dd></div>
        ${s ? html`<div><dt>Conviction</dt><dd class="conv conv-${s.conviction}">${s.conviction[0].toUpperCase() + s.conviction.slice(1)}</dd></div>` : ""}
      </dl>
    </a>`;
}

function skeletonCards() {
  return Array.from({ length: 5 }, () => html`<div class="card cat-card"><div class="skeleton" style="height:18px;width:60%"></div>
    <div class="skeleton" style="height:36px;width:80%;margin-top:18px"></div><div class="skeleton" style="height:44px;margin-top:12px"></div></div>`);
}

export async function render(root) {
  mount(root, html`
    <section class="hero container page-enter">
      <p class="eyebrow" id="updated"><span class="dot"></span>Live from LTA bidding results</p>
      <h1 class="display">Know before<br>you <span class="gradient-text">bid.</span></h1>
      <p class="subtitle">Probabilistic COE forecasts that understand policy shocks — so you can decide whether to buy now or wait, with the odds on the table.</p>
      <div class="hero-cta">
        <a class="btn" href="#/forecast/A">See the forecast</a>
        <a class="btn-secondary link-arrow" href="#how">How it works</a>
      </div>
    </section>

    <section class="container section-tight">
      <div class="grid grid-5" id="cards" data-anchor="category-cards" aria-busy="true">${skeletonCards()}</div>
      <p class="caption mt-16">Signals compare the median forecast one quota quarter ahead (six exercises) with today's premium:
        <strong>Wait</strong> when it is at least 8% lower, otherwise <strong>Buy now</strong> — shown as <strong>Lean buy</strong>
        when prices are about as likely to fall as rise. ${explain("signal", "Buy now and Wait")}
        Conviction ${explain("conviction", "conviction")} says how clear-cut the call is. Not financial advice.</p>
    </section>

    <section class="container section" id="how">
      <p class="eyebrow">How it works</p>
      <h2 class="headline">Policy-aware, by design.</h2>
      <div class="grid grid-3 mt-40">
        <div class="card step"><div class="step-num">1</div><h3>Measure every shock</h3>
          <p>Box-Tiao intervention analysis isolates how much each policy — loan curbs, EV reclassification, quota injections — shifted premiums, net of normal market swings.</p></div>
        <div class="card step"><div class="step-num">2</div><h3>Forecast with attention</h3>
          <p>A Temporal Fusion Transformer reads price history, bidding pressure, macro data and the <em>known</em> future (announced quotas, policy effects), and is blended with the Box-Tiao econometric forecast.</p></div>
        <div class="card step"><div class="step-num">3</div><h3>Decide with odds</h3>
          <p>Instead of one guess you get a range — p10 to p90 — turned into a buy-or-wait signal, a bid planner and a price watchlist.</p></div>
      </div>
    </section>

    <section class="container section" id="stats-section">
      <p class="eyebrow">Tested out of sample</p>
      <h2 class="headline">Numbers we can stand behind.</h2>
      <div class="stats mt-40" id="stats"></div>
      <p class="mt-24"><a class="link-arrow" href="#/model">See the full evaluation</a></p>
    </section>`);

  const cards = root.querySelector("#cards");
  // Opening a card: its data is fetched as soon as it is pointed at or focused,
  // and on click the card's category, premium, median and signal morph into the
  // same items on the Forecast page (a shared-element transition).
  const cardOf = (e) => e.target.closest?.("a.cat-card[data-cat]");
  const warm = (e) => { const card = cardOf(e); if (card) prefetch(card.dataset.cat); };
  cards.addEventListener("pointerover", warm);
  cards.addEventListener("focusin", warm);
  cards.addEventListener("click", (e) => {
    const card = cardOf(e);
    if (!card || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const q = (sel) => card.querySelector(sel);
    requestShared(`#/forecast/${card.dataset.cat}`, [
      [card, "cat-card"], [q(".cat-chip"), "cat-name"], [q(".big-number"), "cat-premium"],
      [q(".cat-median"), "cat-median"], [q(".pill"), "cat-signal"],
    ]);
  });
  try {
    const summary = await api.get("/summary");
    mount(cards, summary.categories.length ? html`${summary.categories.map(categoryCard)}`
      : html`<div class="card empty" style="grid-column:1/-1">No bidding results yet. Run the data pipeline to load them.</div>`);
    if (summary.data_through) {
      const run = summary.run ? ` · model retrained ${timeAgo(summary.run.finished_at || summary.run.created_at)}` : "";
      mount(root.querySelector("#updated"), html`<span class="dot"></span>Updated after ${summary.data_through.label} bidding${run}`);
    }
    api.prefetch("/categories", "/scenarios");      // small; lets any card open without waiting
    setView({ facts: [
      { label: "Data through", value: summary.data_through?.label || "—" },
      ...summary.categories.filter((c) => c.signal).map((c) => ({ label: c.name, value: `${money(c.latest.premium)} · ${c.signal.label}` })),
    ] });
  } catch (err) {
    mount(cards, errorBox(err));
  } finally {
    cards.removeAttribute("aria-busy");
  }

  try {
    const [metrics, events] = await Promise.all([api.get("/model/metrics"), api.get("/policy/events")]);
    const tft = metrics.leaderboard.find((r) => r.model === "hybrid") || metrics.leaderboard[0];
    const years = metrics.test_period.exercises ? metrics.test_period.exercises / 24 : null;
    mount(root.querySelector("#stats"), html`
      <div class="stat"><div class="stat-value">${pct(tft.mape, { sign: false })}</div><div class="stat-label">average error of the median forecast over ${years ? `${years} held-out years` : "the held-out period"}</div></div>
      <div class="stat"><div class="stat-value">${pct(tft.coverage80, { sign: false, digits: 0 })}</div><div class="stat-label">of real outcomes fell inside the 80% range</div></div>
      <div class="stat"><div class="stat-value">${tft.direction == null ? "—" : pct(tft.direction, { sign: false, digits: 0 })}</div><div class="stat-label">of up / down calls were right</div></div>
      <div class="stat"><div class="stat-value">${events.length}</div><div class="stat-label">policy shocks measured with Box-Tiao analysis</div></div>`);
  } catch {
    root.querySelector("#stats-section")?.remove();
  }
}
