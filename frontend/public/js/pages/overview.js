// Home: what COE Compass is, a way in for each kind of visitor, today's market
// for the five categories, the forecast chart, and how the forecasts are made.
// The analytics sit underneath; the page starts from what the visitor wants to do.

import { api } from "../api.js";
import { lineChart, sparkline } from "../charts.js";
import { setView } from "../context.js";
import { drawFan, fanLegend, fanOptions, historyOptions } from "../fan.js";
import { explain } from "../glossary.js";
import { requestShared } from "../motion.js";
import { prefetch } from "./forecast.js";
import {
  CATEGORY_CODES, ICONS, catColor, driverChips, errorBox, forecastId, html, money, mount, noticeBox, onSegment,
  outlookPill, pct, provenance, rangeShort, raw, segmented, sgt,
} from "../util.js";

const INTENTS = [
  { icon: "car", href: "#/plan?intent=buy", title: "Buying a car", body: "See the outlook for your category and how your COE budget compares.", go: "Plan my purchase" },
  { icon: "renew", href: "#/plan?intent=renew", title: "Renewing my COE", body: "Estimate the renewal price (PQP) and where it may be heading.", go: "Compare renewal options" },
  { icon: "gavel", href: "#/bid/A", title: "Planning a bid", body: "See your chance of winning at any bid, and what you would pay.", go: "Explore bid scenarios" },
  { icon: "chart", href: "#/forecast/A", title: "Exploring the market", body: "Forecasts, supply scenarios and what past policies did to premiums.", go: "View full analytics" },
];

const PIPELINE = [
  ["Collect", "Every COE bidding result and quota since 2010, published by LTA on data.gov.sg, plus inflation, interest rates and GDP."],
  ["Model", "Several forecasting methods are trained side by side, including one that measures what past policy changes did to premiums."],
  ["Validate", "Each method is scored on three years of bidding exercises it never saw during training."],
  ["Quantify uncertainty", "Forecasts are published as ranges, and we check how often real results actually fell inside them."],
  ["Publish", "The latest forecast goes live with its model run, timestamp and data sources attached."],
];

function categoryCard(c) {
  const delta = c.change_pct;
  const dir = delta == null || Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
  const s = c.signal;
  return html`
    <a class="card cat-card" href="#/forecast/${c.code}" data-cat="${c.code}"
       aria-label="${c.name}, ${c.title}. Current premium ${money(c.latest.premium)}. ${s ? `Outlook: ${s.label}` : "No forecast yet"}. View forecast">
      <div class="cat-top">
        <span class="cat-chip"><span class="cat-swatch" style="background:${catColor(c.code)}"></span>${c.name}</span>
        <span class="cat-name">${c.title}</span>
      </div>
      <div>
        <div class="cat-label">Current premium</div>
        <div class="big-number">${money(c.latest.premium)}</div>
        <div class="delta ${dir}"><span aria-hidden="true">${arrow}</span> ${pct(delta)} <span class="muted">vs last exercise</span></div>
      </div>
      ${raw(sparkline(c.sparkline, c.horizon_q50 != null ? [c.next_q50, c.horizon_q50] : []))}
      ${s ? html`
        <div>
          <div class="cat-label">Next exercise forecast</div>
          <div class="cat-median">${money(c.next_q50)}</div>
          <div class="cat-range">${rangeShort(c.next_q10, c.next_q90)} likely range</div>
        </div>
        <div class="cat-outlook">${outlookPill(s)}</div>
        ${driverChips(s.drivers)}`
      : html`<p class="small muted">The forecast isn't available yet. Recorded results are shown.</p>`}
      <span class="cat-link">View forecast<span aria-hidden="true"> →</span></span>
    </a>`;
}

function skeletonCards() {
  return Array.from({ length: 5 }, () => html`<div class="card cat-card"><div class="skeleton" style="height:18px;width:60%"></div>
    <div class="skeleton" style="height:36px;width:80%;margin-top:18px"></div><div class="skeleton" style="height:44px;margin-top:12px"></div>
    <div class="skeleton" style="height:60px;margin-top:12px"></div></div>`);
}

export async function render(root) {
  mount(root, html`
    <section class="hero container page-enter">
      <p class="eyebrow">Independent COE decision support, built on official public data</p>
      <h1 class="display">Make sense of Singapore's COE market.</h1>
      <p class="subtitle">Forecasts, scenarios and planning tools that show where premiums may be heading, and how sure anyone can be about it.</p>
      <div class="hero-cta">
        <a class="btn" href="#/forecast/A">Explore current outlook</a>
        <a class="btn btn-outline" href="#/plan">Plan my COE</a>
      </div>
      <p class="hero-meta" id="updated"><span class="dot dot-idle"></span>Loading the latest results…</p>
    </section>

    <section class="container section-tight" aria-labelledby="intent-title">
      <h2 class="title" id="intent-title">What are you planning?</h2>
      <div class="grid grid-4 mt-16">
        ${INTENTS.map((i) => html`<a class="card intent" href="${i.href}">
          <span class="intent-icon">${raw(ICONS[i.icon])}</span>
          <strong>${i.title}</strong><span class="intent-body">${i.body}</span>
          <span class="cat-link">${i.go}<span aria-hidden="true"> →</span></span></a>`)}
      </div>
    </section>

    <section class="container section-tight" aria-labelledby="market-title">
      <h2 class="title" id="market-title">Today's COE market</h2>
      <div class="grid grid-5 mt-16" id="cards" data-anchor="category-cards" aria-busy="true">${skeletonCards()}</div>
      <p class="caption mt-16">The <strong>likely range</strong> is where the model expects the next premium to land about 8 times in 10
        ${explain("range-80", "80% range")}. The <strong>outlook</strong> says which way the forecast leans by the end of the next quota quarter
        ${explain("outlook", "market outlook")}. It describes the forecast and is not advice to buy or to wait.</p>
    </section>

    <section class="container section-tight">
      <div class="card card-lg" id="home-chart-card">
        <div class="card-head">
          <div><h2 class="title">Premium and forecast</h2><p class="card-sub" id="home-chart-sub" aria-live="polite">Loading…</p></div>
          ${segmented("home-cat", CATEGORY_CODES.map((c) => ({ value: c, label: `Cat ${c}` })), "A", "COE category")}
        </div>
        ${fanLegend()}
        <div id="home-fan"><div class="skeleton" style="height:${window.innerWidth < 600 ? 260 : 320}px"></div></div>
        <div id="home-notice"></div>
        <div id="home-provenance"></div>
        <p class="mt-16"><a class="link-arrow" id="home-forecast-link" href="#/forecast/A">Open the full Cat A forecast</a></p>
      </div>
    </section>

    <section class="container section" id="how">
      <p class="eyebrow">How COE Compass makes forecasts</p>
      <h2 class="headline">From public data to a range you can plan around.</h2>
      <ol class="pipeline mt-24">
        ${PIPELINE.map(([title, body], i) => html`<li class="card step"><div class="step-num">${i + 1}</div><h3>${title}</h3><p>${body}</p></li>`)}
      </ol>
      <p class="mt-24 row"><a class="link-arrow" href="#/learn/how">How the forecasts are made</a>
        <a class="link-arrow" href="#/learn/sources">Data sources</a></p>
    </section>

    <section class="container section" id="stats-section">
      <p class="eyebrow">Tested on results the model never saw</p>
      <h2 class="headline">Numbers we can stand behind.</h2>
      <div class="stats mt-24" id="stats"></div>
      <p class="mt-24"><a class="link-arrow" href="#/model">See the full model performance</a></p>
    </section>`);

  const cards = root.querySelector("#cards");
  // Opening a card: its data is fetched as soon as it is pointed at or focused,
  // and on click the card's category, premium, forecast and outlook morph into
  // the same items on the Forecast page (a shared-element transition).
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

  // ---- the forecast chart: one category at a time, changed in place ----
  let chart = null;
  let chartToken = 0;
  async function drawChart(cat, { animate = false } = {}) {
    const token = ++chartToken;
    const holder = root.querySelector("#home-fan");
    const sub = root.querySelector("#home-chart-sub");
    const height = window.innerWidth < 600 ? 260 : 320;
    holder.classList.add("is-loading");
    const [history, forecast] = await Promise.allSettled([api.get(`/history/${cat}?years=1`), api.get(`/forecast/${cat}?scenario=base`)]);
    if (token !== chartToken || !root.isConnected) return;
    holder.classList.remove("is-loading");
    root.querySelector("#home-forecast-link").href = `#/forecast/${cat}`;
    root.querySelector("#home-forecast-link").textContent = `Open the full Cat ${cat} forecast`;
    if (history.status !== "fulfilled" || !history.value.points.length) {
      chart?.destroy();
      chart = null;
      mount(holder, errorBox(history.reason, "The premium history couldn't be loaded"));
      sub.textContent = "";
      return;
    }
    const points = history.value.points;
    const notice = root.querySelector("#home-notice");
    if (forecast.status !== "fulfilled") {
      // No forecast (the model has not run, or its service is down): history still works.
      const opts = historyOptions({ history: points, name: `Cat ${cat}`, height });
      if (chart) chart.update(opts, { animate, resetZoom: true }); else chart = lineChart(holder, opts);
      sub.textContent = `Cat ${cat}: recorded premiums for the last year.`;
      mount(notice, noticeBox({ title: "Latest forecast temporarily unavailable",
        body: "Recorded COE results remain available. The forecast returns once the model service is back.", tone: "warn", retry: true }));
      mount(root.querySelector("#home-provenance"), "");
      return;
    }
    mount(notice, "");
    const f = forecast.value;
    const { opts, last } = fanOptions({ history: points, steps: f.steps, name: `Cat ${cat}`, height });
    sub.textContent = `Cat ${cat}: latest result ${money(points[points.length - 1].premium)} (${f.origin.label}), then the forecast for the next six bidding exercises.`;
    if (chart) chart.update(opts, { animate, resetZoom: true }); else chart = drawFan(holder, opts, last);
    mount(root.querySelector("#home-provenance"), provenance({ run: f.run, dataThrough: f.origin.label, id: forecastId(cat, f.steps[0], f.run) }));
  }
  onSegment(root, "home-cat", (c) => drawChart(c, { animate: true }));
  root.querySelector('[data-seg="home-cat"]').addEventListener("pointerover", (e) => {
    const c = e.target.closest("button[data-value]")?.dataset.value;
    if (c) api.prefetch(`/history/${c}?years=1`, `/forecast/${c}?scenario=base`);
  });

  try {
    const summary = await api.get("/summary");
    mount(cards, summary.categories.length ? html`${summary.categories.map(categoryCard)}`
      : html`<div class="card empty" style="grid-column:1/-1">No bidding results yet. Run the data pipeline to load them.</div>`);
    if (summary.data_through) {
      const when = summary.run ? `Updated ${sgt(summary.run.finished_at || summary.run.created_at)} · ` : "";
      mount(root.querySelector("#updated"), html`<span class="dot"></span>${when}${summary.data_through.label} bidding exercise included
        <span class="tick" aria-hidden="true">✓</span>`);
    }
    api.prefetch("/categories", "/scenarios");      // small; lets any card open without waiting
    setView({ facts: [
      { label: "Data through", value: summary.data_through?.label || "—" },
      ...summary.categories.filter((c) => c.signal).map((c) => ({ label: c.name, value: `${money(c.latest.premium)} · ${c.signal.label}` })),
    ] });
  } catch (err) {
    mount(cards, html`<div style="grid-column:1/-1">${errorBox(err, "Today's market couldn't be loaded")}</div>`);
    mount(root.querySelector("#updated"), html`<span class="dot dot-idle"></span>Latest results unavailable`);
  } finally {
    cards.removeAttribute("aria-busy");
  }

  await drawChart("A");

  try {
    const [metrics, events] = await Promise.all([api.get("/model/metrics"), api.get("/policy/events")]);
    const ours = metrics.leaderboard.find((r) => r.model === "hybrid") || metrics.leaderboard[0];
    const years = metrics.test_period.exercises ? metrics.test_period.exercises / 24 : null;
    mount(root.querySelector("#stats"), html`
      <div class="stat"><div class="stat-value">${pct(ours.mape, { sign: false })}</div><div class="stat-label">average error of the median forecast over ${years ? `${years} held-out years` : "the held-out period"}</div></div>
      <div class="stat"><div class="stat-value">${pct(ours.coverage80, { sign: false, digits: 0 })}</div><div class="stat-label">of real outcomes fell inside the 80% range</div></div>
      <div class="stat"><div class="stat-value">${ours.direction == null ? "—" : pct(ours.direction, { sign: false, digits: 0 })}</div><div class="stat-label">of up / down calls were right</div></div>
      <div class="stat"><div class="stat-value">${events.length}</div><div class="stat-label">past policy changes measured for their effect on premiums</div></div>`);
  } catch {
    root.querySelector("#stats-section")?.remove();
  }
  return () => chart?.destroy();
}
