// Policy Lab: premium history with policy markers, and each event's Box-Tiao effect.

import { api } from "../api.js";
import { lineChart } from "../charts.js";
import {
  CATEGORY_CODES, catColor, errorBox, exerciseDate, html, money, moneyShort, mount, onSegment, pct, segmented,
} from "../util.js";

const KIND = { step: "Permanent shift", pulse: "One-off shock", temporary: "Temporary shift" };
// Short names for the chart markers (the timeline shows the full names).
const SHORT = {
  mas_loan_curbs_2013: "Loan curbs", cat_a_power_cap_2014: "97kW cap", mas_loan_easing_2016: "Loan easing",
  zero_growth_2018: "Zero growth", covid_resumption_2020: "Post-lockdown", ev_reclassification_2022: "EV 110kW",
  cut_and_fill_2023: "Cut-and-fill", quota_injection_2025: "Injection",
};
const LIMIT = 60;   // effect bars are drawn on a ±60% scale

function effectRow(e) {
  const clamp = (v) => Math.max(-LIMIT, Math.min(LIMIT, v));
  const toPos = (v) => 50 + (clamp(v) / LIMIT) * 50;
  const value = e.pct_effect;
  const left = value < 0 ? toPos(value) : 50;
  const width = Math.abs(toPos(value) - 50);
  const ci = e.pct_low != null ? html`<span class="effect-ci" style="left:${toPos(e.pct_low)}%;width:${toPos(e.pct_high) - toPos(e.pct_low)}%"></span>` : "";
  const sig = e.significant ? "significant" : "not significant";
  return html`
    <div class="effect-row" title="${`Cat ${e.category}: ${pct(value)} (95% CI ${pct(e.pct_low)} to ${pct(e.pct_high)}), ${sig}`}">
      <span class="cat-chip"><span class="cat-swatch" style="background:${catColor(e.category)}"></span>Cat ${e.category}</span>
      <span class="effect-track" aria-hidden="true"><span class="effect-zero"></span>${ci}
        <span class="effect-bar" style="left:${left}%;width:${width}%;background:${value < 0 ? "var(--down)" : "var(--up)"}"></span></span>
      <span class="effect-val"><strong>${pct(value)}</strong> <span class="muted">${e.significant ? "p<0.05" : "n.s."}</span></span>
    </div>`;
}

function eventCard(ev) {
  const date = new Date(ev.effective_month);
  const when = date.toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });
  return html`
    <div class="event">
      <div class="event-date">${when}</div>
      <div class="card">
        <div class="row-between"><h3>${ev.name}</h3><span class="pill pill-neutral">${KIND[ev.kind] || ev.kind}</span></div>
        <p class="muted small mt-8">${ev.description}</p>
        ${ev.effects.length
          ? html`<div class="mt-16">${ev.effects.map(effectRow)}</div>
                 <p class="tiny mt-8">Bars show the estimated level shift in the premium; whiskers are 95% confidence intervals.</p>`
          : html`<p class="small mt-16 muted">Not enough data after this event to estimate its effect yet.</p>`}
        ${ev.source_url ? html`<p class="tiny mt-8"><a href="${ev.source_url}" target="_blank" rel="noopener">Source</a></p>` : ""}
      </div>
    </div>`;
}

export async function render(root, { category = "B" } = {}) {
  category = CATEGORY_CODES.includes(category) ? category : "B";
  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Policy Lab</p>
      <h1 class="headline">Every shock, measured.</h1>
      <p class="subtitle">Box-Tiao intervention analysis separates what a policy did to premiums from the market's usual ups and downs. These estimates feed the forecast as known inputs.</p>
    </section>
    <section class="container">
      <div class="filters">
        <div class="filter"><span class="filter-label">Category</span>
          ${segmented("cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), category, "COE category")}</div>
      </div>
      <div class="card card-lg">
        <div class="card-head"><div><h2 class="title">Premium history with policy events</h2>
          <p class="card-sub" id="hist-sub">Each vertical line marks when a policy took effect.</p></div></div>
        <div id="history"><div class="skeleton" style="height:320px"></div></div>
      </div>
      <div class="timeline mt-40" id="events"></div>
      <div class="card mt-40">
        <h2 class="title">How to read this</h2>
        <p class="muted small mt-8">For each category we fit <em>y<sub>t</sub> = Σ ω<sub>k</sub>·I<sub>k</sub>(t) + N<sub>t</sub></em> on the Box-Cox-transformed premium, where I<sub>k</sub> switches on when policy k takes effect and N<sub>t</sub> is an ARIMA(p,1,q) process chosen by AIC. ω<sub>k</sub> is the policy's level shift after accounting for normal dynamics; we convert it into a percentage of the premium just before the event. Effects of events that overlap in time (e.g. 2013 and 2014) are hard to separate, so read wide intervals with care.</p>
      </div>
    </section>`);

  let chart;
  onSegment(root, "cat", (c) => { category = c; drawHistory(); });

  const events = await api.get("/policy/events").catch((err) => { mount(root.querySelector("#events"), errorBox(err)); return []; });
  mount(root.querySelector("#events"), html`${events.map(eventCard)}`);

  async function drawHistory() {
    const holder = root.querySelector("#history");
    holder.classList.add("chart-loading");
    const h = await api.get(`/history/${category}?years=0`);
    chart?.destroy();
    const pts = h.points.map((p) => ({ x: exerciseDate(p.month, p.bidding_no), y: p.premium, label: p.label }));
    const byTime = new Map(pts.map((p) => [+p.x, p]));
    const relevant = events.filter((e) => e.categories.includes(category));
    root.querySelector("#hist-sub").textContent =
      `Cat ${category}: ${relevant.length} policy events apply. Each vertical line marks when one took effect.`;
    chart = lineChart(holder, {
      label: `Cat ${category} premium history with policy events`, height: window.innerWidth < 600 ? 260 : 340,
      series: [{ key: "p", label: "Premium", color: `var(--cat-${category})`, points: pts }],
      markers: relevant.map((e) => ({ x: new Date(e.effective_month), label: SHORT[e.code] || e.name })),
      yFormat: moneyShort,
      tooltip: (x) => {
        const p = byTime.get(+x);
        return p ? { title: p.label, rows: [{ value: money(p.y), label: `Cat ${category}`, color: `var(--cat-${category})` }] } : null;
      },
    });
    holder.classList.remove("chart-loading");
  }
  await drawHistory();
  return () => chart?.destroy();
}
