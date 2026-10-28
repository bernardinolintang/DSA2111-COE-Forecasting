// Forecast: key figures, the fan chart, the market outlook with its evidence,
// the next-six table and market pulse, always for supply as announced. Supply
// what-ifs live in the Scenario Lab (pages/scenario.js).
//
// Category and history range change in place: the selection slides, numbers
// interpolate and the chart morphs. The header and every number switch together
// once the new data has arrived, so a category's name is never shown beside
// another category's values. If the forecast is unavailable the page still
// shows the recorded history, with a notice saying so.

import { api } from "../api.js";
import { columnChart, dataTable, lineChart } from "../charts.js";
import { setView } from "../context.js";
import { drawFan, fanLegend, fanOptions, historyOptions } from "../fan.js";
import { explain } from "../glossary.js";
import { DURATION, animateNumber, enter, swap } from "../motion.js";
import { buildHash } from "../route.js";
import {
  CATEGORY_CODES, ICONS, UNCERTAINTY, errorBox, forecastId, html, money, mount, noticeBox, number, onSegment,
  outlookPill, pct, provenance, rangeShort, raw, segmented, sgt, store,
} from "../util.js";

const RANGES = [
  { value: "1", label: "1Y" }, { value: "3", label: "3Y" }, { value: "5", label: "5Y" }, { value: "0", label: "All" },
];
// Short names for policy markers on charts (the Policy Lab shows the full names).
export const POLICY_SHORT = {
  mas_loan_curbs_2013: "Loan curbs", cat_a_power_cap_2014: "97kW cap", mas_loan_easing_2016: "Loan easing",
  zero_growth_2018: "Zero growth", covid_resumption_2020: "Post-lockdown", ev_reclassification_2022: "EV 110kW",
  cut_and_fill_2023: "Cut-and-fill", quota_injection_2025: "Injection",
};
const pct0 = (v) => pct(v, { sign: false, digits: 0 });
const ARROW = { up: "↑", down: "↓", flat: "→" };

/** Warm the cache for a category's forecast (card hover/focus), so opening it is instant. */
export function prefetch(category) {
  const years = store.get("coe-range", "1");
  api.prefetch("/categories", `/history/${category}?years=${years}`, `/forecast/${category}?scenario=base`,
    `/recommendation/${category}?scenario=base`, "/policy/events");
}

export async function render(root, { category = "A" } = {}, page = {}) {
  const categories = await api.get("/categories");
  const metaOf = (c) => categories.find((x) => x.code === c);
  const state = {
    category: CATEGORY_CODES.includes(category) ? category : "A",
    years: store.get("coe-range", "1"),
    table: false,
  };
  let shownCategory = state.category;         // the category whose data is on screen
  const meta = metaOf(state.category);

  // Key figures shown before the data arrives come from the Overview's summary
  // when it is already loaded: the same numbers, so nothing jumps when data lands.
  const pre = api.peek("/summary")?.categories.find((c) => c.code === state.category);
  const preFc = pre?.signal ? pre : null;

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Forecast</p>
      <h1 class="headline" id="fc-title"><span class="fc-cat">${meta.name}</span> · <span id="fc-cat-title">${meta.title}</span></h1>
      <p class="subtitle" id="fc-desc">${meta.description}</p>
    </section>

    <section class="container">
      <div class="filters">
        <div class="filter"><span class="filter-label">Category</span>
          ${segmented("cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), state.category, "COE category")}</div>
        <div class="filter"><span class="filter-label">History</span>
          ${segmented("range", RANGES, state.years, "History range")}</div>
      </div>

      <div class="card fc-figures" id="figures">
        <div class="fig">
          <div class="fig-label">Latest premium <span class="fig-when" id="fig-latest-when">${pre ? pre.latest.label : ""}</span></div>
          <div class="fig-value" id="fig-latest">${pre ? money(pre.latest.premium) : "—"}</div>
        </div>
        <div class="fig">
          <div class="fig-label">Next exercise <span class="fig-when" id="fig-median-label">${preFc ? preFc.next_label : ""}</span>
            ${explain("median", "median forecast")}</div>
          <div class="fig-value" id="fig-median">${preFc ? money(preFc.next_q50) : "—"}</div>
          <div class="fig-sub"><span id="fig-next-range">${preFc ? rangeShort(preFc.next_q10, preFc.next_q90) : "—"}</span> likely range ${explain("range-80", "80% range")}</div>
        </div>
        <div class="fig">
          <div class="fig-label">End of quarter <span class="fig-when" id="fig-horizon-label">${preFc ? preFc.horizon_label : ""}</span>
            ${explain("horizon", "forecast horizon")}</div>
          <div class="fig-value" id="fig-horizon">${preFc ? money(preFc.horizon_q50) : "—"}</div>
          <div class="fig-sub"><span id="fig-horizon-range">${preFc ? rangeShort(preFc.horizon_q10, preFc.horizon_q90) : "—"}</span> likely range</div>
        </div>
        <div class="fig fig-signal">
          <div class="fig-label">Market outlook ${explain("outlook", "market outlook")}</div>
          <div id="fig-signal">${preFc ? outlookPill(preFc.signal) : html`<span class="pill pill-neutral">…</span>`}</div>
        </div>
      </div>
      <div id="fc-notice" aria-live="polite"></div>

      <div class="split mt-24">
        <div class="card card-lg" id="chart-card" data-anchor="forecast-chart">
          <div class="card-head">
            <div><h2 class="title">Premium and forecast</h2><p class="card-sub" id="chart-sub" aria-live="polite">Loading…</p></div>
            <button class="btn btn-ghost btn-sm table-toggle" id="toggle-table" aria-pressed="false">Table view</button>
          </div>
          ${fanLegend()}
          <div id="fan"><div class="skeleton" style="height:${window.innerWidth < 600 ? 280 : 360}px"></div></div>
          <div id="fan-table" hidden></div>
          <div id="fc-provenance"></div>
        </div>
        <div class="card card-lg" id="advice" data-anchor="recommendation" aria-live="polite"><div class="skeleton" style="height:260px"></div></div>
      </div>

      <div class="card card-lg mt-24" data-anchor="forecast-table">
        <div class="card-head"><div><h2 class="title">Next six bidding exercises</h2>
          <p class="card-sub" id="steps-sub">The forecast for each upcoming exercise, with supply as announced. The premium should land between Low and High about 8 times in 10.</p></div></div>
        <div id="steps"><div class="skeleton" style="height:280px"></div></div>
      </div>

      <div class="grid grid-2 mt-24">
        <div class="card"><div class="card-head"><div><h2 class="title">Bids per COE ${explain("bids-per-coe", "bids per COE")}</h2>
          <p class="card-sub">Bids received ÷ quota, last two years. Above 1 means more bidders than certificates.</p></div></div>
          <div id="pressure"><div class="skeleton" style="height:200px"></div></div></div>
        <div class="card"><div class="card-head"><div><h2 class="title">Quota per exercise ${explain("quota", "quota")}</h2>
          <p class="card-sub">COEs released each bidding exercise, last two years.</p></div></div>
          <div id="quota"><div class="skeleton" style="height:200px"></div></div></div>
      </div>

      <div class="grid grid-3 mt-24 next-steps">
        <a class="card next-step" id="lab-link" href="#/scenario/${state.category}"><strong>What if supply changes?</strong>
          <span>Drag next quarter's quota up or down and watch the forecast respond.</span><span class="cat-link">Open the Scenario Lab<span aria-hidden="true"> →</span></span></a>
        <a class="card next-step" id="plan-link" href="#/bid/${state.category}"><strong>Planning to bid?</strong>
          <span>See your chance of winning the next exercise at any bid.</span><span class="cat-link">Plan your bid<span aria-hidden="true"> →</span></span></a>
        <a class="card next-step" href="#/model"><strong>Can I rely on this?</strong>
          <span>How the forecasts did on three years of results the model never saw.</span><span class="cat-link">How accurate is this?<span aria-hidden="true"> →</span></span></a>
      </div>
    </section>`);

  const $ = (sel) => root.querySelector(sel);
  const press = (name, value) => root.querySelectorAll(`[data-seg="${name}"] button`)
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));

  // Category links create a history entry; the router hands them back to
  // page.navigate below, so Back/Forward also work in place.
  onSegment(root, "cat", (c) => { location.hash = buildHash({ page: "forecast", category: c }); });
  // A history range is an explicit choice of window, so it also clears any zoom.
  onSegment(root, "range", (y) => { state.years = y; store.set("coe-range", y); zoomReset = true; update(); });
  // Pointing at a choice fetches its data, so the switch itself is instant.
  $('[data-seg="cat"]').addEventListener("pointerover", (e) => {
    const c = e.target.closest("button[data-value]")?.dataset.value;
    if (c && c !== state.category) prefetch(c);
  });
  $("#toggle-table").addEventListener("click", (e) => {
    state.table = !state.table;
    e.currentTarget.setAttribute("aria-pressed", String(state.table));
    e.currentTarget.textContent = state.table ? "Chart view" : "Table view";
    $("#fan").hidden = state.table;
    $("#fan-table").hidden = !state.table;
    enter(state.table ? $("#fan-table") : $("#fan"), { rise: 0, duration: DURATION.tab });
  });
  setView({ category: state.category });

  page.navigate = ({ category: c }) => {
    const next = CATEGORY_CODES.includes(c) ? c : "A";
    press("cat", next);
    if (next === state.category) return true;
    state.category = next;
    setView({ category: next, facts: [] });
    update();
    loadPulse();
    return true;
  };

  // ---- market pulse: depends on the category only ----
  const pulse = { pressure: null, quota: null, token: 0 };
  async function loadPulse() {
    const token = ++pulse.token;
    let h;
    try {
      h = await api.get(`/history/${state.category}?years=2`);
    } catch (err) {
      if (root.isConnected && token === pulse.token) {
        [pulse.pressure, pulse.quota].forEach((c) => c?.destroy());
        pulse.pressure = null;
        pulse.quota = null;
        mount($("#pressure"), errorBox(err, "Market pulse couldn't be loaded"));
        mount($("#quota"), "");
      }
      return;
    }
    if (!root.isConnected || token !== pulse.token) return;
    const pts = h.points;
    const every = Math.ceil(pts.length / (window.innerWidth < 600 ? 4 : 8));      // fewer labels on a phone
    const tick = (p, i) => (i % every === 0 ? p.label.split(" · ")[0].replace(/ 20/, " '") : "");
    const pressure = pts.map((p, i) => ({ label: tick(p, i), title: p.label, value: p.bids_received / Math.max(p.quota, 1), seriesLabel: "bids per COE" }));
    const quota = pts.map((p, i) => ({ label: tick(p, i), title: p.label, value: p.quota, seriesLabel: "COEs" }));
    if (pulse.pressure && pulse.quota) {
      pulse.pressure.update(pressure, { animate: true });
      pulse.quota.update(quota, { animate: true });
    } else {
      pulse.pressure = columnChart($("#pressure"), { items: pressure, yFormat: (v) => v.toFixed(1), label: "Bids per COE", height: 200 });
      pulse.quota = columnChart($("#quota"), { items: quota, yFormat: (v) => number(v), label: "Quota per exercise",
                                               height: 200, color: "var(--neutral-mark)" });
    }
  }
  loadPulse();

  // Every update is tagged; a slower, older response (e.g. after quickly clicking
  // Cat B then Cat C) is discarded instead of overwriting the newer one.
  let latestUpdate = 0;
  let fanChart = null;
  let fanKind = null;            // "fan" | "history": what the chart is showing
  let first = true;
  let zoomReset = false;

  /** Policy events for this category inside the plotted window, as chart markers. */
  function policyMarkers(events, history, cat) {
    if (!events?.length || !history.length) return [];
    const from = new Date(history[0].month);
    return events.filter((e) => e.categories.includes(cat) && new Date(e.effective_month) >= from)
      .map((e) => ({ x: new Date(e.effective_month), label: POLICY_SHORT[e.code] || e.name }));
  }

  async function update() {
    const token = ++latestUpdate;
    const { category: cat, years } = state;
    const busy = [$("#fan"), $("#advice"), $("#figures")];
    busy.forEach((el) => { el.classList.add("is-loading"); el.setAttribute("aria-busy", "true"); });
    const done = () => busy.forEach((el) => { el.classList.remove("is-loading"); el.removeAttribute("aria-busy"); });
    const [history, forecast, advice, events, summary] = await Promise.allSettled([
      api.get(`/history/${cat}?years=${years}`),
      api.get(`/forecast/${cat}?scenario=base`),
      api.get(`/recommendation/${cat}?scenario=base`),
      api.get("/policy/events"),
      api.get("/summary"),               // already loaded by the status bar; names the last good run
    ]);
    if (token !== latestUpdate || !root.isConnected) return;
    done();
    const animate = !first;
    if (cat !== shownCategory) renderHeader(cat);
    shownCategory = cat;

    if (history.status !== "fulfilled" || !history.value.points.length) {
      // Nothing to plot at all.
      fanChart?.destroy();
      fanChart = null;
      fanKind = null;
      mount($("#fan"), errorBox(history.reason || new Error("No bidding results are stored for this category yet.")));
      mount($("#advice"), noticeBox({ title: "No outlook yet", body: "The outlook appears once results and a forecast are available." }));
      $("#chart-sub").textContent = "The premium history couldn't be loaded.";
      mount($("#fc-notice"), "");
      return;
    }
    const points = history.value.points;
    const markers = policyMarkers(events.value, points, cat);
    if (forecast.status !== "fulfilled" || advice.status !== "fulfilled") {
      renderHistoryOnly(points, markers, forecast.reason || advice.reason, summary.value?.run);
      first = false;
      return;
    }
    mount($("#fc-notice"), "");
    renderFigures(forecast.value, advice.value, animate);
    renderFan(points, forecast.value, markers, animate);
    renderOutlook(advice.value, animate);
    renderSteps(forecast.value);
    publish(forecast.value, advice.value);
    first = false;
  }

  function renderHeader(cat) {
    const m = metaOf(cat);
    swap($("#fc-title"), () => {
      $("#fc-title .fc-cat").textContent = m.name;
      $("#fc-cat-title").textContent = m.title;
    }, { key: cat });
    swap($("#fc-desc"), () => { $("#fc-desc").textContent = m.description; }, { key: cat, distance: 3 });
    $("#plan-link").href = `#/bid/${cat}`;
    $("#lab-link").href = `#/scenario/${cat}`;
  }

  /** The forecast is unavailable: keep the recorded history on screen and say what happened. */
  function renderHistoryOnly(points, markers, reason, lastRun) {
    const last = points[points.length - 1];
    $("#fig-latest-when").textContent = last.label;
    animateNumber($("#fig-latest"), last.premium, { format: money, animate: false });
    for (const id of ["#fig-median", "#fig-horizon", "#fig-next-range", "#fig-horizon-range"]) $(id).textContent = "—";
    mount($("#fig-signal"), outlookPill(null));
    mount($("#fc-notice"), html`<div class="mt-16">${noticeBox({
      title: "Latest forecast temporarily unavailable", tone: "warn", retry: true,
      body: `Recorded COE results remain available.${lastRun ? ` Last successful update: ${sgt(lastRun.finished_at || lastRun.created_at)}.` : ""} ${reason?.message || ""}`.trim(),
    })}</div>`);
    const opts = historyOptions({ history: points, name: metaOf(state.category).name, height: window.innerWidth < 600 ? 280 : 360, markers });
    if (fanChart) fanChart.update(opts, { animate: false, resetZoom: true });
    else fanChart = lineChart($("#fan"), opts);
    fanKind = "history";
    $("#chart-sub").textContent = `Latest result ${money(last.premium)} (${last.label}). Recorded premiums only.`;
    mount($("#fan-table"), raw(dataTable(
      [{ label: "Exercise", get: (r) => r.label }, { label: "Recorded premium", num: true, get: (r) => money(r.premium) }], [...points].reverse())));
    mount($("#advice"), noticeBox({ title: "No outlook right now", body: "The market outlook needs the forecast, which is temporarily unavailable." }));
    mount($("#steps"), noticeBox({ title: "The next six exercises will appear here when the forecast is back." }));
    mount($("#fc-provenance"), "");
  }

  function renderFigures(forecast, a, animate) {
    const [next] = forecast.steps;
    const end = forecast.steps[forecast.steps.length - 1];
    $("#fig-latest-when").textContent = forecast.origin.label;
    animateNumber($("#fig-latest"), forecast.origin.premium, { format: money, animate });
    $("#fig-median-label").textContent = next.label;
    animateNumber($("#fig-median"), next.q50, { format: money, animate });
    $("#fig-next-range").textContent = rangeShort(next.q10, next.q90);
    $("#fig-horizon-label").textContent = end.label;
    animateNumber($("#fig-horizon"), end.q50, { format: money, animate });
    $("#fig-horizon-range").textContent = rangeShort(end.q10, end.q90);
    const sig = $("#fig-signal");
    swap(sig, () => { mount(sig, outlookPill(a)); }, { key: a.outlook, animate });
  }

  function renderFan(points, forecast, markers, animate) {
    const { opts, last, rows } = fanOptions({
      history: points, steps: forecast.steps, name: metaOf(state.category).name,
      height: window.innerWidth < 600 ? 280 : 360, markers,
    });
    $("#chart-sub").textContent =
      `Latest result ${money(last.y)} (${last.label}), then the forecast for the next six bidding exercises.`;
    if (fanChart && fanKind === "fan") {
      fanChart.update(opts, { animate, resetZoom: zoomReset });
    } else {
      fanChart?.destroy();
      fanChart = drawFan($("#fan"), opts, last);
    }
    fanKind = "fan";
    zoomReset = false;
    mount($("#fan-table"), raw(dataTable(
      [{ label: "Exercise", get: (r) => r.label }, { label: "Recorded", num: true, get: (r) => (r.type === "actual" ? money(r.y) : "") },
       { label: "Low", num: true, get: (r) => (r.q10 ? money(r.q10) : "") }, { label: "Most likely", num: true, get: (r) => (r.q50 ? money(r.q50) : "") },
       { label: "High", num: true, get: (r) => (r.q90 ? money(r.q90) : "") }],
      rows,
    )));
    mount($("#fc-provenance"), provenance({ run: forecast.run, dataThrough: forecast.origin.label,
                                           id: forecastId(state.category, forecast.steps[0], forecast.run) }));
  }

  // ---- market outlook: built once, then updated field by field ----
  function probRow(key, term) {
    return html`<div class="prob-row" data-prob="${key}">
      <div class="row-between small"><span class="muted"><span class="prob-label"></span> ${term ? explain(term, "chance of a meaningful drop") : ""}</span><strong class="prob-value"></strong></div>
      <div class="meter mt-8" role="meter" aria-valuemin="0" aria-valuemax="100"><span></span></div></div>`;
  }

  function setProb(key, label, value, animate) {
    const row = $(`[data-prob="${key}"]`);
    const labelEl = row.querySelector(".prob-label");
    swap(labelEl, () => { labelEl.textContent = label; }, { key: label, animate, distance: 3 });
    animateNumber(row.querySelector(".prob-value"), value, { format: pct0, animate });
    const meter = row.querySelector(".meter");
    meter.setAttribute("aria-valuenow", String(Math.round(value)));
    meter.setAttribute("aria-label", label);
    meter.firstElementChild.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }

  function indicator(d) {
    if (d.key === "quota") {
      return { label: "Quota", arrow: ARROW[d.trend], text: d.trend === "flat" ? "about the same as a year ago" : `${pct(d.value, { digits: 0 })} vs a year ago` };
    }
    if (d.key === "demand") {
      return { label: "Demand", arrow: ARROW[d.trend], text: `${d.value.toFixed(2)} bids per COE` };
    }
    return null;
  }

  function renderOutlook(a, animate) {
    const box = $("#advice");
    if (!box.querySelector(".outlook")) {
      mount(box, html`
        <div class="outlook">
          <p class="eyebrow" style="margin:0"><span class="advice-for"></span> ${explain("outlook", "market outlook")}</p>
          <div class="outlook-label"></div>
          <p class="outlook-summary"></p>
          <dl class="indicators"></dl>
          ${probRow("direction")}
          ${probRow("drop", "prob-drop")}
          <h3 class="why-title">Why?</h3>
          <ul class="reasons"></ul>
          <p class="caption advice-rule"></p>
        </div>`);
      animate = false;
    }
    const el = box.querySelector(".outlook");
    const when = a.horizon_label.split(" · ")[0];
    const threshold = Math.round(a.threshold_pct);
    el.className = `outlook outlook-${a.direction} strength-${a.strength}`;
    el.querySelector(".advice-for").textContent = `Market outlook for ${metaOf(state.category).name}`;
    // The outlook changes calmly (fades and slides a few px), never with a flash:
    // it informs a large financial decision, and "No clear direction" is drawn
    // in plain ink so it never looks more certain than it is.
    const label = el.querySelector(".outlook-label");
    swap(label, () => { mount(label, html`${raw(ICONS[a.direction])}<span>${a.label}</span>`); }, { key: a.outlook, animate });
    const summary = el.querySelector(".outlook-summary");
    swap(summary, () => { summary.textContent = a.summary; }, { key: a.summary, animate, distance: 3 });

    const rows = [
      { label: "Forecast direction", arrow: ARROW[a.direction], text: `${pct(a.expected_change_pct)} by ${when}` },
      ...a.drivers.map(indicator).filter(Boolean),
      { label: "Model uncertainty", term: "uncertainty", text: `${UNCERTAINTY[a.uncertainty]} · ±${Math.round(a.uncertainty_pct)}%` },
    ];
    const indicators = el.querySelector(".indicators");
    swap(indicators, () => {
      mount(indicators, html`${rows.map((r) => html`<div><dt>${r.label}${r.term ? html` ${explain(r.term, "model uncertainty")}` : ""}</dt>
        <dd>${r.arrow ? html`<span class="ind-arrow" aria-hidden="true">${r.arrow}</span> ` : ""}${r.text}</dd></div>`)}`);
    }, { key: rows.map((r) => r.text).join("|"), animate, distance: 3 });

    const lower = a.prob_lower_pct >= 50;
    setProb("direction", `Chance the premium is ${lower ? "lower" : "higher"} by ${when}`, lower ? a.prob_lower_pct : a.prob_higher_pct, animate);
    setProb("drop", `Chance of a drop of ${threshold}% or more`, a.prob_drop_pct, animate);
    const reasons = el.querySelector(".reasons");
    swap(reasons, () => { mount(reasons, html`${a.reasons.map((r) => html`<li>${r}</li>`)}`); },
      { key: a.reasons.join("|"), animate, distance: 3 });
    el.querySelector(".advice-rule").textContent =
      `Lowest most-likely premium over the next six exercises: ${money(a.cheapest_q50)} (${a.cheapest_label}). `
      + "This describes the forecast and is not advice to buy or to wait: the model forecasts the COE premium only, one part of the cost of a car.";
  }

  function renderSteps(forecast) {
    // A reference table: updated instantly, never animated.
    const origin = forecast.origin.premium;
    mount($("#steps"), raw(dataTable(
      [{ label: "Exercise", get: (s) => s.label }, { label: "Quota", num: true, get: (s) => number(s.quota) },
       { label: "Low", num: true, get: (s) => money(s.q10) }, { label: "Most likely", num: true, get: (s) => money(s.q50) },
       { label: "High", num: true, get: (s) => money(s.q90) }, { label: "vs today", num: true, get: (s) => pct((s.q50 / origin - 1) * 100) }],
      forecast.steps,
    )));
  }

  function publish(forecast, a) {
    const [next] = forecast.steps;
    const end = forecast.steps[forecast.steps.length - 1];
    setView({ facts: [
      { label: "Current premium", value: `${money(forecast.origin.premium)} (${forecast.origin.label})` },
      { label: `Median, ${next.label}`, value: money(next.q50) },
      { label: `Median, ${end.label}`, value: money(end.q50) },
      { label: "80% range by then", value: rangeShort(end.q10, end.q90) },
      { label: "Outlook", value: a.label },
      { label: "Model uncertainty", value: UNCERTAINTY[a.uncertainty] },
    ] });
  }

  await update();
  return () => { [pulse.pressure, pulse.quota, fanChart].forEach((c) => c?.destroy()); };
}
