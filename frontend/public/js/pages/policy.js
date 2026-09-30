// Policy Lab: premium history with policy markers, and each event's Box-Tiao effect,
// explained in plain language first with the statistics one click away.
//
// Selecting an event (the chips under the chart, or "Show on chart" on its card)
// emphasises its marker, shades the period it affected and shows its impact in
// words right under the chart, so the event, the chart and the explanation are
// always seen together. Nothing depends on hover.

import { api } from "../api.js";
import { dataTable, lineChart } from "../charts.js";
import { replaceHash, setPageActions, setView } from "../context.js";
import { explain } from "../glossary.js";
import { DURATION, enter, reducedMotion, swap } from "../motion.js";
import { buildHash } from "../route.js";
import {
  CATEGORY_CODES, catColor, errorBox, exerciseDate, html, money, moneyShort, mount, onSegment, pct, raw, segmented,
} from "../util.js";

const KIND = { step: "Permanent shift", pulse: "One-off shock", temporary: "Temporary shift" };
// Short names for the chart markers (the timeline shows the full names).
const SHORT = {
  mas_loan_curbs_2013: "Loan curbs", cat_a_power_cap_2014: "97kW cap", mas_loan_easing_2016: "Loan easing",
  zero_growth_2018: "Zero growth", covid_resumption_2020: "Post-lockdown", ev_reclassification_2022: "EV 110kW",
  cut_and_fill_2023: "Cut-and-fill", quota_injection_2025: "Injection",
};
const LIMIT = 60;   // effect bars are drawn on a ±60% scale

/** One sentence a car buyer can read, e.g. "... about 10.8% lower, but not statistically significant". */
export function plainEffect(e, kind) {
  const size = Math.abs(e.pct_effect);
  const dir = e.pct_effect < 0 ? "lower" : "higher";
  const when = kind === "temporary" ? "while it was in force" : kind === "pulse" ? "at the time" : "after this change";
  if (size < 0.5) return `The model finds essentially no change in Cat ${e.category} premiums ${when}.`;
  const base = `The model estimates Cat ${e.category} premiums were about ${size.toFixed(1)}% ${dir} ${when}`;
  return e.significant
    ? `${base}, and the effect is statistically significant (unlikely to be noise).`
    : `${base}, but the effect is not statistically significant — it could plausibly be zero.`;
}

/** The period shaded on the chart for an event, and how to describe it. */
export function eventPeriod(ev) {
  const start = new Date(ev.effective_month);
  if (ev.kind === "temporary" && ev.end_month) {
    return { x0: start, x1: new Date(ev.end_month), text: "the period it was in force" };
  }
  const months = ev.kind === "pulse" ? 3 : 12;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + months);
  return { x0: start, x1: end, text: `the ${months} months after it took effect` };
}

const monthYear = (d) => new Date(d).toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });

function effectRow(e, selected) {
  const clamp = (v) => Math.max(-LIMIT, Math.min(LIMIT, v));
  const toPos = (v) => 50 + (clamp(v) / LIMIT) * 50;
  const value = e.pct_effect;
  const left = value < 0 ? toPos(value) : 50;
  const width = Math.abs(toPos(value) - 50);
  const ci = e.pct_low != null ? html`<span class="effect-ci" style="left:${toPos(e.pct_low)}%;width:${toPos(e.pct_high) - toPos(e.pct_low)}%"></span>` : "";
  const sig = e.significant ? "significant" : "not significant";
  return html`
    <div class="effect-row${selected ? " is-selected" : ""}" title="${`Cat ${e.category}: ${pct(value)} (95% CI ${pct(e.pct_low)} to ${pct(e.pct_high)}), ${sig}`}">
      <span class="cat-chip"><span class="cat-swatch" style="background:${catColor(e.category)}"></span>Cat ${e.category}</span>
      <span class="effect-track" aria-hidden="true"><span class="effect-zero"></span>${ci}
        <span class="effect-bar" style="left:${left}%;width:${width}%;background:${value < 0 ? "var(--down)" : "var(--up)"}"></span></span>
      <span class="effect-val"><strong>${pct(value)}</strong> <span class="muted">${e.significant ? "p<0.05" : "n.s."}</span></span>
    </div>`;
}

function plainFor(ev, category) {
  const mine = ev.effects.find((e) => e.category === category);
  return mine ? plainEffect(mine, ev.kind)
    : ev.categories.includes(category) ? `Not enough data after this event to estimate its effect on Cat ${category} yet.`
    : `This policy did not apply to Cat ${category}.`;
}

function eventCard(ev, category, selected) {
  const applies = ev.categories.includes(category);
  return html`
    <div class="event${selected ? " is-selected" : ""}" id="event-${ev.code}" data-event="${ev.code}" tabindex="-1">
      <div class="event-date">${monthYear(ev.effective_month)}</div>
      <div class="card">
        <div class="row-between"><h3>${ev.name}</h3>
          <span class="row" style="gap:4px"><span class="pill pill-neutral">${KIND[ev.kind] || ev.kind}</span>${explain("effect-types", "type of policy effect")}</span></div>
        <p class="muted small mt-8">${ev.description}</p>
        <p class="plain mt-16"><strong>What it means for Cat ${category}:</strong> ${plainFor(ev, category)}</p>
        ${applies ? html`<p class="mt-8"><button type="button" class="btn btn-ghost btn-sm" data-show-event="${ev.code}"
            aria-pressed="${selected}">${selected ? "Shown on chart" : "Show on chart"}</button></p>` : ""}
        ${ev.effects.length
          ? html`<div class="mt-16">${ev.effects.map((e) => effectRow(e, e.category === category))}</div>
                 <p class="caption mt-8">Bars show the estimated level shift in the premium; whiskers are 95% confidence intervals
                   ${explain("confidence-interval", "confidence interval")}. n.s. = not statistically significant ${explain("significance", "n.s. and p<0.05")}</p>
                 <details class="tech-details mt-8"><summary>Technical details</summary>
                   ${raw(dataTable([
                     { label: "Category", get: (e) => `Cat ${e.category}` },
                     { label: "Effect", num: true, get: (e) => pct(e.pct_effect) },
                     { label: "95% CI", num: true, get: (e) => (e.pct_low != null ? `${pct(e.pct_low)} to ${pct(e.pct_high)}` : "—") },
                     { label: "p-value", num: true, get: (e) => (e.p_value != null ? e.p_value.toFixed(3) : "—") },
                     { label: "Significant (p<0.05)", get: (e) => (e.significant ? "Yes" : "No") },
                   ], ev.effects))}
                   <p class="caption mt-8">Box-Tiao intervention model, ${KIND[ev.kind]?.toLowerCase() || ev.kind} dummy; effect converted to % of the premium just before the event.</p>
                 </details>`
          : html`<p class="small mt-16 muted">Not enough data after this event to estimate its effect yet.</p>`}
        ${ev.source_url ? html`<p class="mt-16"><a class="source-link" href="${ev.source_url}" target="_blank" rel="noopener">Official source<span class="visually-hidden"> (opens in a new tab)</span> ↗</a></p>` : ""}
      </div>
    </div>`;
}

export async function render(root, { category = "B", query = {} } = {}, page = {}) {
  category = CATEGORY_CODES.includes(category) ? category : "B";
  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Policy Lab</p>
      <h1 class="headline">Every shock, measured.</h1>
      <p class="subtitle">Box-Tiao intervention analysis ${explain("box-tiao", "Box-Tiao intervention analysis")} separates what a policy did to premiums from the market's usual ups and downs. These estimates feed the forecast as known inputs.</p>
    </section>
    <section class="container">
      <div class="filters">
        <div class="filter"><span class="filter-label">Category</span>
          ${segmented("cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), category, "COE category")}</div>
      </div>
      <div class="card card-lg" id="policy-chart-card" data-anchor="policy-chart">
        <div class="card-head"><div><h2 class="title">Premium history with policy events</h2>
          <p class="card-sub" id="hist-sub">Each vertical line marks when a policy took effect.</p></div></div>
        <div id="history"><div class="skeleton" style="height:320px"></div></div>
        <div class="event-picker mt-16" id="event-picker" role="group" aria-label="Show a policy event on the chart"></div>
        <div class="policy-focus mt-16" id="policy-focus" aria-live="polite" hidden></div>
      </div>
      <div class="timeline mt-40" id="events" data-anchor="policy-events"></div>
      <div class="card mt-40">
        <h2 class="title">How to read this</h2>
        <p class="muted small mt-8">Each bar is the estimated change in premiums after a policy, after allowing for the market's normal movement. Short whiskers that don't cross zero mean a clear effect; long whiskers crossing zero mean the data can't tell the effect apart from no effect.</p>
        <details class="tech-details mt-16"><summary>Methodology</summary>
          <p class="muted small mt-8">For each category we fit <em>y<sub>t</sub> = Σ ω<sub>k</sub>·I<sub>k</sub>(t) + N<sub>t</sub></em> on the Box-Cox-transformed premium, where I<sub>k</sub> switches on when policy k takes effect and N<sub>t</sub> is an ARIMA(p,1,q) process chosen by AIC. ω<sub>k</sub> is the policy's level shift after accounting for normal dynamics; we convert it into a percentage of the premium just before the event. Effects of events that overlap in time (e.g. 2013 and 2014) are hard to separate, so read wide intervals with care.</p>
        </details>
      </div>
    </section>`);

  const $ = (sel) => root.querySelector(sel);
  let chart = null;
  let events = [];
  let latestDraw = 0;
  let selected = null;                 // code of the event shown on the chart
  let rendered = false;

  const relevant = () => events.filter((e) => e.categories.includes(category));
  const markers = () => relevant().map((e) => ({ x: new Date(e.effective_month), label: SHORT[e.code] || e.name, active: e.code === selected }));
  const regions = () => {
    const ev = events.find((e) => e.code === selected);
    return ev ? [eventPeriod(ev)] : [];
  };

  function renderEvents() {
    const box = $("#events");
    const fill = () => mount(box, events.length ? html`${events.map((ev) => eventCard(ev, category, ev.code === selected))}`
      : html`<div class="card empty">No policy events recorded yet.</div>`);
    swap(box, fill, { key: category, animate: rendered, distance: 4 });
    rendered = true;
  }

  function paintPicker() {
    const list = relevant();
    mount($("#event-picker"), list.length ? html`
      <span class="filter-label">Show on chart</span>
      ${list.map((e) => html`<button type="button" class="event-chip" data-pick="${e.code}" aria-pressed="${e.code === selected}">
        ${SHORT[e.code] || e.name}<span class="muted"> · ${new Date(e.effective_month).getUTCFullYear()}</span></button>`)}` : "");
  }

  function paintFocus() {
    const box = $("#policy-focus");
    const ev = events.find((e) => e.code === selected);
    if (!ev) { box.hidden = true; return; }
    const period = eventPeriod(ev);
    const fill = () => mount(box, html`
      <div class="row-between"><div><strong>${ev.name}</strong> <span class="muted small">· ${monthYear(ev.effective_month)}</span></div>
        <span class="pill pill-neutral">${KIND[ev.kind] || ev.kind}</span></div>
      <p class="plain mt-8">${plainFor(ev, category)}</p>
      <p class="caption mt-8">Shaded on the chart: ${period.text}.
        <button type="button" class="link-btn" data-goto-event="${ev.code}">Read the full estimate</button></p>`);
    const wasHidden = box.hidden;
    box.hidden = false;
    if (wasHidden) { fill(); enter(box, { rise: 6, duration: DURATION.tab }); }
    else swap(box, fill, { key: `${ev.code}|${category}`, distance: 4 });
  }

  function markCards() {
    root.querySelectorAll("[data-event]").forEach((el) => {
      const on = el.dataset.event === selected;
      el.classList.toggle("is-selected", on);
      const b = el.querySelector("[data-show-event]");
      if (b) { b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "Shown on chart" : "Show on chart"; }
    });
  }

  /** Show one event on the chart (or none), in place: marker, shaded period, summary. */
  function select(code, { scroll = false } = {}) {
    const ev = events.find((e) => e.code === code && e.categories.includes(category));
    selected = ev ? ev.code : null;
    replaceHash(buildHash({ page: "policy", category, event: selected }));
    setView({ event: selected });
    paintPicker();
    paintFocus();
    markCards();
    chart?.update({ markers: markers(), regions: regions() }, { animate: true, duration: DURATION.card });
    if (scroll && ev) $("#policy-chart-card").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  }

  function highlightEvent(code) {
    const el = code && root.querySelector(`[data-event="${CSS.escape(code)}"]`);
    if (!el) return;
    if (events.find((e) => e.code === code)?.categories.includes(category)) select(code);
    el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    el.classList.remove("is-highlighted");
    void el.offsetWidth;
    el.classList.add("is-highlighted");
    el.focus({ preventScroll: true });
  }

  async function drawHistory({ animate = false } = {}) {
    const token = ++latestDraw;
    const cat = category;
    const holder = $("#history");
    holder.classList.add("is-loading");
    try {
      const h = await api.get(`/history/${cat}?years=0`);
      if (token !== latestDraw) return;
      const pts = h.points.map((p) => ({ x: exerciseDate(p.month, p.bidding_no), y: p.premium, label: p.label }));
      const byTime = new Map(pts.map((p) => [+p.x, p]));
      $("#hist-sub").textContent =
        `Cat ${cat}: ${relevant().length} policy events apply. Each vertical line marks when one took effect.`;
      const opts = {
        label: `Cat ${cat} premium history with policy events`, height: window.innerWidth < 600 ? 260 : 340,
        series: [{ key: "p", label: "Premium", color: `var(--cat-${cat})`, points: pts }],
        markers: markers(), regions: regions(), zoom: true,
        yFormat: moneyShort,
        tooltip: (x) => {
          const p = byTime.get(+x);
          return p ? { title: p.label, rows: [{ value: money(p.y), label: `Cat ${cat}`, color: `var(--cat-${cat})` }] } : null;
        },
      };
      if (chart) chart.update(opts, { animate });
      else chart = lineChart(holder, opts);
    } catch (err) {
      if (token !== latestDraw) return;
      chart?.destroy();
      chart = null;
      mount(holder, errorBox(err));
    } finally {
      if (token === latestDraw) holder.classList.remove("is-loading");
    }
  }

  function publish() {
    const effects = events.flatMap((ev) => ev.effects.filter((e) => e.category === category).map((e) => ({ ev, e })));
    const biggest = effects.sort((a, b) => Math.abs(b.e.pct_effect) - Math.abs(a.e.pct_effect))[0];
    setView({ category, facts: [
      { label: "Category", value: `Cat ${category}` },
      { label: "Policy events that apply", value: String(relevant().length) },
      ...(biggest ? [{ label: "Largest estimated effect", value: `${biggest.ev.name}: ${pct(biggest.e.pct_effect)}${biggest.e.significant ? "" : " (n.s.)"}` }] : []),
    ] });
  }

  function setCategory(c) {
    if (!CATEGORY_CODES.includes(c)) return;
    category = c;
    root.querySelectorAll('[data-seg="cat"] button').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === c)));
    if (selected && !events.find((e) => e.code === selected)?.categories.includes(c)) selected = null;
    replaceHash(buildHash({ page: "policy", category: c, event: selected }));
    setView({ event: selected });
    renderEvents();
    paintPicker();
    paintFocus();
    publish();
    drawHistory({ animate: true });
  }

  onSegment(root, "cat", setCategory);
  $("#event-picker").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b) select(b.dataset.pick === selected ? null : b.dataset.pick);
  });
  $("#policy-focus").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto-event]");
    if (b) highlightEvent(b.dataset.gotoEvent);
  });
  $("#events").addEventListener("click", (e) => {
    const b = e.target.closest("[data-show-event]");
    if (b) select(b.dataset.showEvent === selected ? null : b.dataset.showEvent, { scroll: b.dataset.showEvent !== selected });
  });
  setPageActions({ setCategory, highlightEvent });
  setView({ category, event: query.event || null });
  page.navigate = ({ category: c, query: q = {} }) => {
    if (c && c !== category) setCategory(c);
    if (q.event) highlightEvent(q.event);
    return true;
  };

  try {
    events = await api.get("/policy/events");
  } catch (err) {
    mount($("#events"), errorBox(err));
  }
  if (query.event && events.find((e) => e.code === query.event)?.categories.includes(category)) selected = query.event;
  renderEvents();
  paintPicker();
  paintFocus();
  publish();
  await drawHistory();
  if (query.event) highlightEvent(query.event);
  return () => chart?.destroy();
}
