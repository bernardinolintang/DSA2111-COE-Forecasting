// Forecast: key figures, fan chart with supply scenarios, buy/wait advice,
// next-six table, market pulse.
//
// Category, scenario and history range all change in place: the selection
// slides, numbers interpolate and the chart morphs, so a scenario visibly moves
// the forecast instead of a new graph appearing. The header and every number
// switch together once the new data has arrived, so a category's name is never
// shown beside another category's values.

import { api } from "../api.js";
import { columnChart, dataTable, lineChart } from "../charts.js";
import { replaceHash, setPageActions, setView } from "../context.js";
import { explain } from "../glossary.js";
import { DURATION, animateNumber, enter, reducedMotion, swap } from "../motion.js";
import { buildHash } from "../route.js";
import {
  CATEGORY_CODES, CONVICTION, ICONS, errorBox, exerciseDate, html, money, moneyShort, mount, number, onSegment, pct,
  raw, segmented, signalPill, store,
} from "../util.js";

const RANGES = [
  { value: "1", label: "1Y" }, { value: "3", label: "3Y" }, { value: "5", label: "5Y" }, { value: "0", label: "All" },
];
const pct0 = (v) => pct(v, { sign: false, digits: 0 });

/** Warm the cache for a category's forecast (card hover/focus), so opening it is instant. */
export function prefetch(category, scenario = "base") {
  const years = store.get("coe-range", "1");
  api.prefetch("/categories", "/scenarios", `/history/${category}?years=${years}`,
    `/forecast/${category}?scenario=${scenario}`, `/recommendation/${category}?scenario=${scenario}`,
    `/forecast/${category}?scenario=base`);
}

/** How a scenario's median compares with the as-announced one, in words (never colour alone). */
export function scenarioDelta(median, baseMedian, scenario) {
  if (scenario === "base" || median == null || baseMedian == null) return null;
  const diff = median - baseMedian;
  const rel = (diff / baseMedian) * 100;
  const supply = /plus/.test(scenario) ? "More" : "Less";
  if (Math.abs(rel) < 0.5) {
    return { diff, rel, dir: "flat", text: `${supply} supply than announced barely changes the model's projected premium.` };
  }
  const dir = diff < 0 ? "down" : "up";
  return { diff, rel, dir,
    text: `${supply} supply than announced ${dir === "down" ? "lowers" : "raises"} the model's projected premium.` };
}

export async function render(root, { category = "A", query = {} } = {}, page = {}) {
  const [categories, scenarios] = await Promise.all([api.get("/categories"), api.get("/scenarios")]);
  const scenarioIds = scenarios.map((s) => s.id);
  const validScenario = (id) => (scenarioIds.includes(id) ? id : "base");
  const metaOf = (c) => categories.find((x) => x.code === c);
  const state = {
    category: CATEGORY_CODES.includes(category) ? category : "A",
    scenario: validScenario(query.scenario),
    years: store.get("coe-range", "1"),
    table: false,
  };
  let shownCategory = state.category;         // the category whose data is on screen
  const meta = metaOf(state.category);

  // Key figures shown before the data arrives come from the Overview's summary
  // when it is already loaded: the same numbers, so nothing jumps when data lands.
  const pre = api.peek("/summary")?.categories.find((c) => c.code === state.category);
  const preBase = pre && state.scenario === "base";

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
        <div class="filter" data-anchor="scenario-picker"><span class="filter-label">Next quarter's supply
          ${explain("supply-scenario", "supply scenario")}</span>
          ${segmented("scenario", scenarios.map((s) => ({ value: s.id, label: s.label })), state.scenario, "Supply scenario")}</div>
        <div class="filter"><span class="filter-label">History</span>
          ${segmented("range", RANGES, state.years, "History range")}</div>
      </div>

      <div class="card fc-figures" id="figures">
        <div class="fig">
          <div class="fig-label">Latest premium <span class="fig-when" id="fig-latest-when">${pre ? pre.latest.label : ""}</span></div>
          <div class="fig-value" id="fig-latest">${pre ? money(pre.latest.premium) : "—"}</div>
        </div>
        <div class="fig">
          <div class="fig-label"><span id="fig-median-label">Median forecast${preBase && pre.horizon_label ? `, ${pre.horizon_label}` : ""}</span>
            ${explain("median", "median forecast")}</div>
          <div class="fig-value" id="fig-median">${preBase ? money(pre.horizon_q50) : "—"}</div>
          <div class="fig-delta" id="fig-delta">
            <span class="fig-cmp" hidden><span class="fig-dir"><span class="fig-arrow" aria-hidden="true"></span></span>
              <span class="fig-delta-amt"></span> <span class="fig-rest"></span></span>
            <span class="fig-base muted">Supply as announced</span>
          </div>
        </div>
        <div class="fig fig-signal">
          <div class="fig-label">Our read</div>
          <div id="fig-signal">${preBase && pre.signal ? signalPill(pre.signal) : html`<span class="pill pill-neutral">…</span>`}</div>
        </div>
        <p class="fig-note caption" id="fig-note" aria-live="polite" hidden></p>
      </div>

      <div class="split mt-24">
        <div class="card card-lg" id="chart-card" data-anchor="forecast-chart">
          <div class="card-head">
            <div><h2 class="title">Premium & forecast</h2><p class="card-sub" id="chart-sub" aria-live="polite">Loading…</p></div>
            <button class="btn btn-ghost btn-sm table-toggle" id="toggle-table" aria-pressed="false">Table view</button>
          </div>
          <ul class="legend">
            <li><span class="key-line" style="background:var(--ink)"></span>Actual premium</li>
            <li><span class="key-line" style="background:var(--accent)"></span>Median forecast ${explain("median", "median forecast")}</li>
            <li><span class="key-band" style="background:var(--accent-wash-2)"></span>50% range ${explain("range-50", "50% range")}</li>
            <li><span class="key-band" style="background:var(--accent-wash)"></span>80% range ${explain("range-80", "80% range")}</li>
          </ul>
          <div id="fan"><div class="skeleton" style="height:${window.innerWidth < 600 ? 280 : 360}px"></div></div>
          <div id="fan-table" hidden></div>
        </div>
        <div class="card card-lg" id="advice" data-anchor="recommendation" aria-live="polite"><div class="skeleton" style="height:260px"></div></div>
      </div>

      <div class="card card-lg mt-24" data-anchor="forecast-table">
        <div class="card-head"><div><h2 class="title">Next six bidding exercises</h2>
          <p class="card-sub" id="steps-sub">Quantiles of the forecast distribution for each upcoming exercise.</p></div></div>
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

      <p class="mt-24 row"><a class="link-arrow" id="plan-link" href="#/bid/${state.category}">Plan your bid</a>
        <a class="link-arrow" href="#/model">How accurate is this?</a></p>
    </section>`);

  const $ = (sel) => root.querySelector(sel);
  const press = (name, value) => root.querySelectorAll(`[data-seg="${name}"] button`)
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));

  function setScenario(id) {
    if (!scenarioIds.includes(id)) return;
    state.scenario = id;
    press("scenario", id);
    replaceHash(buildHash({ page: "forecast", category: state.category, scenario: id }));
    setView({ scenario: id });
    update();
  }

  // Category links keep the scenario and create a history entry; the router
  // hands them back to page.navigate below, so Back/Forward also work in place.
  onSegment(root, "cat", (c) => { location.hash = buildHash({ page: "forecast", category: c, scenario: state.scenario }); });
  onSegment(root, "scenario", setScenario);
  // A history range is an explicit choice of window, so it also clears any zoom.
  onSegment(root, "range", (y) => { state.years = y; store.set("coe-range", y); zoomReset = true; update(); });
  // Pointing at a choice fetches its data, so the switch itself is instant.
  $('[data-seg="cat"]').addEventListener("pointerover", (e) => {
    const c = e.target.closest("button[data-value]")?.dataset.value;
    if (c && c !== state.category) prefetch(c, state.scenario);
  });
  $('[data-seg="scenario"]').addEventListener("pointerover", (e) => {
    const s = e.target.closest("button[data-value]")?.dataset.value;
    if (s) api.prefetch(`/forecast/${state.category}?scenario=${s}`, `/recommendation/${state.category}?scenario=${s}`);
  });
  $("#toggle-table").addEventListener("click", (e) => {
    state.table = !state.table;
    e.currentTarget.setAttribute("aria-pressed", String(state.table));
    e.currentTarget.textContent = state.table ? "Chart view" : "Table view";
    $("#fan").hidden = state.table;
    $("#fan-table").hidden = !state.table;
    enter(state.table ? $("#fan-table") : $("#fan"), { rise: 0, duration: DURATION.tab });
  });
  setView({ category: state.category, scenario: state.scenario });
  setPageActions({ setScenario });

  page.navigate = ({ category: c, query: q = {} }) => {
    const next = CATEGORY_CODES.includes(c) ? c : "A";
    const scenario = validScenario(q.scenario);
    press("cat", next);
    press("scenario", scenario);
    if (next === state.category && scenario === state.scenario) return true;
    const catChanged = next !== state.category;
    state.category = next;
    state.scenario = scenario;
    setView({ category: next, scenario, facts: [] });
    update();
    if (catChanged) loadPulse();
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
        pulse.pressure?.destroy();
        pulse.pressure = null;
        mount($("#pressure"), errorBox(err));
      }
      return;
    }
    if (!root.isConnected || token !== pulse.token) return;
    const pts = h.points;
    const every = Math.ceil(pts.length / 8);
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
  // +10% then +20%, or Cat B then Cat C) is discarded instead of overwriting the newer one.
  let latestUpdate = 0;
  let fanChart = null;
  let first = true;
  let zoomReset = false;

  async function update() {
    const token = ++latestUpdate;
    const { category: cat, scenario, years } = state;
    const busy = [$("#fan"), $("#advice"), $("#figures")];
    busy.forEach((el) => { el.classList.add("is-loading"); el.setAttribute("aria-busy", "true"); });
    try {
      const [history, forecast, advice, base] = await Promise.all([
        api.get(`/history/${cat}?years=${years}`),
        api.get(`/forecast/${cat}?scenario=${scenario}`),
        api.get(`/recommendation/${cat}?scenario=${scenario}`),
        api.get(`/forecast/${cat}?scenario=base`),
      ]);
      if (token !== latestUpdate || !root.isConnected) return;
      busy.forEach((el) => { el.classList.remove("is-loading"); el.removeAttribute("aria-busy"); });
      const animate = !first;
      if (cat !== shownCategory) renderHeader(cat);
      shownCategory = cat;
      renderFigures(forecast, base, advice, animate);
      renderFan(history, forecast, animate);
      renderAdvice(advice, animate);
      renderSteps(forecast);
      publish(forecast, advice);
      first = false;
    } catch (err) {
      if (token !== latestUpdate) return;
      fanChart?.destroy();
      fanChart = null;
      mount($("#fan"), errorBox(err));
      mount($("#advice"), errorBox(err));
      $("#chart-sub").textContent = "The forecast couldn't be loaded.";
      busy.forEach((el) => { el.classList.remove("is-loading"); el.removeAttribute("aria-busy"); });
    }
  }

  function renderHeader(cat) {
    const m = metaOf(cat);
    swap($("#fc-title"), () => {
      $("#fc-title .fc-cat").textContent = m.name;
      $("#fc-cat-title").textContent = m.title;
    }, { key: cat });
    swap($("#fc-desc"), () => { $("#fc-desc").textContent = m.description; }, { key: cat, distance: 3 });
    $("#plan-link").href = `#/bid/${cat}`;
  }

  function renderFigures(forecast, base, a, animate) {
    const end = forecast.steps[forecast.steps.length - 1];
    const baseEnd = base.steps[base.steps.length - 1];
    $("#fig-latest-when").textContent = forecast.origin.label;
    animateNumber($("#fig-latest"), forecast.origin.premium, { format: money, animate });
    $("#fig-median-label").textContent = `Median forecast, ${end.label}`;
    animateNumber($("#fig-median"), end.q50, { format: money, animate });

    // "↓ $8,444 lower than as announced": the amount interpolates; the words
    // around it only swap when the direction changes.
    const d = scenarioDelta(end.q50, baseEnd.q50, state.scenario);
    const deltaEl = $("#fig-delta");
    const cmp = deltaEl.querySelector(".fig-cmp");
    const amount = deltaEl.querySelector(".fig-delta-amt");
    const wasComparing = !cmp.hidden;
    swap(deltaEl, () => {
      cmp.hidden = !d;
      deltaEl.querySelector(".fig-base").hidden = Boolean(d);
    }, { key: d ? "cmp" : "base", animate });
    if (d) {
      deltaEl.className = `fig-delta ${d.dir}`;
      const dirEl = deltaEl.querySelector(".fig-dir");
      swap(dirEl, () => {
        dirEl.querySelector(".fig-arrow").textContent = d.dir === "down" ? "↓" : d.dir === "up" ? "↑" : "≈";
        deltaEl.querySelector(".fig-rest").textContent =
          d.dir === "flat" ? "vs as announced" : `${d.dir === "down" ? "lower" : "higher"} than as announced`;
      }, { key: d.dir, animate: animate && wasComparing });
      animateNumber(amount, Math.abs(d.diff), { format: money, animate: animate && wasComparing });
    } else {
      deltaEl.className = "fig-delta";
    }
    const note = $("#fig-note");
    if (d) {
      const text = `${d.text} Median ${pct(d.rel)} vs as announced.`;
      if (note.hidden) {
        note.textContent = text;
        note.hidden = false;
        if (animate) enter(note, { rise: 4, duration: DURATION.tab });
      } else if (note.textContent !== text) {
        note.textContent = text;
      }
    } else {
      note.hidden = true;
    }
    const sig = $("#fig-signal");
    swap(sig, () => { mount(sig, signalPill(a)); }, { key: `${a.label}|${a.conviction}`, animate });
  }

  function renderFan(history, forecast, animate) {
    const hist = history.points.map((p) => ({ x: exerciseDate(p.month, p.bidding_no), y: p.premium, label: p.label }));
    const last = hist[hist.length - 1];
    const steps = forecast.steps.map((s) => ({ ...s, x: exerciseDate(s.month, s.bidding_no) }));
    const withOrigin = (lo, hi) => [{ x: last.x, lo: last.y, hi: last.y }, ...steps.map((s) => ({ x: s.x, lo: s[lo], hi: s[hi] }))];
    const byTime = new Map([...hist.map((p) => [+p.x, { type: "actual", ...p }]), ...steps.map((s) => [+s.x, { type: "fc", ...s }])]);

    $("#chart-sub").textContent =
      `Last result ${money(last.y)} (${last.label}). Shaded: forecast ranges for the next six exercises.`;
    const opts = {
      label: `${metaOf(state.category).name} premium history and forecast`,
      height: window.innerWidth < 600 ? 280 : 360,
      series: [
        { key: "actual", label: "Actual", color: "var(--ink)", points: hist },
        { key: "median", label: "Median", color: "var(--accent)", points: [{ x: last.x, y: last.y }, ...steps.map((s) => ({ x: s.x, y: s.q50 }))], endDot: true },
      ],
      bands: [
        { key: "p10-p90", color: "var(--accent)", opacity: 0.12, points: withOrigin("q10", "q90") },
        { key: "p25-p75", color: "var(--accent)", opacity: 0.2, points: withOrigin("q25", "q75") },
      ],
      now: last.x, nowLabel: "Latest",
      // Zoomable; "Zoom to forecast" frames the last half-year and the six forecast exercises.
      zoom: true,
      focus: { x0: hist[Math.max(0, hist.length - 13)].x, x1: steps[steps.length - 1].x, label: "Zoom to forecast" },
      yFormat: moneyShort,
      tooltip: (x) => {
        const d = byTime.get(+x);
        if (!d) return null;
        if (d.type === "actual") {
          return { title: d.label, rows: [{ value: money(d.y), label: "premium", color: "var(--ink)" }] };
        }
        return { title: `${d.label} · forecast`, rows: [
          { value: money(d.q50), label: "median", color: "var(--accent)" },
          { value: `${moneyShort(d.q25)}–${moneyShort(d.q75)}`, label: "50% range", color: "var(--accent-wash-2)" },
          { value: `${moneyShort(d.q10)}–${moneyShort(d.q90)}`, label: "80% range", color: "var(--accent-wash)" },
        ] };
      },
    };
    if (fanChart) {
      fanChart.update(opts, { animate, resetZoom: zoomReset });
      zoomReset = false;
    } else if (reducedMotion()) {
      fanChart = lineChart($("#fan"), opts);
    } else {
      // First paint: the forecast fans out from the latest result (history is drawn as is).
      const flat = (pts) => pts.map((p) => ("lo" in p ? { ...p, lo: last.y, hi: last.y } : { ...p, y: last.y }));
      fanChart = lineChart($("#fan"), {
        ...opts,
        series: opts.series.map((s) => (s.key === "median" ? { ...s, points: flat(s.points) } : s)),
        bands: opts.bands.map((b) => ({ ...b, points: flat(b.points) })),
      });
      fanChart.update(opts, { animate: true, duration: DURATION.route + 120 });
    }
    mount($("#fan-table"), raw(dataTable(
      [{ label: "Exercise", get: (r) => r.label }, { label: "Actual", num: true, get: (r) => (r.type === "actual" ? money(r.y) : "") },
       { label: "p10", num: true, get: (r) => (r.q10 ? money(r.q10) : "") }, { label: "Median", num: true, get: (r) => (r.q50 ? money(r.q50) : "") },
       { label: "p90", num: true, get: (r) => (r.q90 ? money(r.q90) : "") }],
      [...byTime.values()].reverse(),
    )));
  }

  // ---- recommendation: built once, then updated field by field ----
  function probRow(key) {
    return html`<div class="prob-row" data-prob="${key}">
      <div class="row-between small"><span class="muted"><span class="prob-label"></span> ${key === "save" ? explain("prob-save", "chance waiting saves") : ""}</span><strong class="prob-value"></strong></div>
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

  function renderAdvice(a, animate) {
    const box = $("#advice");
    if (!box.querySelector(".advice")) {
      mount(box, html`
        <div class="advice">
          <p class="eyebrow" style="margin:0"><span class="advice-for"></span> ${explain("signal", "Buy now and Wait")}</p>
          <div class="advice-action"></div>
          <div class="row"><span class="conv-chip"></span>${explain("conviction", "conviction")}</div>
          <p class="advice-summary"></p>
          ${probRow("direction")}
          ${probRow("save")}
          <p class="caption">Conviction is how clearly the forecast supports this call — not the chance that prices rise.</p>
          <dl class="kv">
            <div><dt>Today</dt><dd class="kv-today"></dd></div>
            <div><dt class="kv-median-label"></dt><dd class="kv-median"></dd></div>
            <div><dt>Change</dt><dd class="kv-change"></dd></div>
          </dl>
          <ul class="reasons"></ul>
          <p class="caption advice-rule"></p>
        </div>`);
      animate = false;
    }
    const el = box.querySelector(".advice");
    const wait = a.action === "wait";
    const when = a.horizon_label.split(" · ")[0];
    const threshold = Math.round(a.threshold_pct);
    el.className = `advice ${wait ? "advice-wait" : "advice-buy"} conv-${a.conviction}`;
    el.querySelector(".advice-for").textContent = `Our read for ${metaOf(state.category).name}`;
    // The call changes calmly (fades and slides a few px), never with a flash or
    // pulse: it is a large financial decision, and a low-conviction call keeps
    // its softer styling (see .conv-low) so it never looks more certain than it is.
    const action = el.querySelector(".advice-action");
    swap(action, () => { mount(action, html`${raw(wait ? ICONS.clock : ICONS.check)}${a.label}`); }, { key: a.label, animate });
    const chip = el.querySelector(".conv-chip");
    swap(chip, () => { chip.className = `conv-chip conv-${a.conviction}`; chip.textContent = CONVICTION[a.conviction]; },
      { key: a.conviction, animate });
    const summary = el.querySelector(".advice-summary");
    swap(summary, () => { summary.textContent = a.summary; }, { key: a.summary, animate, distance: 3 });
    setProb("direction", wait ? `Chance prices are lower by ${when}` : `Chance prices are higher by ${when}`,
      wait ? a.prob_lower_pct : a.prob_higher_pct, animate);
    setProb("save", `Chance waiting saves ${threshold}% or more`, a.prob_save_pct, animate);
    animateNumber(el.querySelector(".kv-today"), a.current, { format: moneyShort, animate });
    el.querySelector(".kv-median-label").textContent = `Median, ${when}`;
    animateNumber(el.querySelector(".kv-median"), a.horizon_q50, { format: moneyShort, animate });
    animateNumber(el.querySelector(".kv-change"), a.expected_change_pct, { format: (v) => pct(v), animate });
    const reasons = el.querySelector(".reasons");
    swap(reasons, () => { mount(reasons, html`${a.reasons.map((r) => html`<li>${r}</li>`)}`); },
      { key: a.reasons.join("|"), animate, distance: 3 });
    el.querySelector(".advice-rule").textContent =
      `Rule: wait if the median one quarter ahead is ≥${threshold}% below today. Lowest expected premium: ${money(a.cheapest_q50)} (${a.cheapest_label}). Not financial advice.`;
  }

  function renderSteps(forecast) {
    // A reference table: updated instantly, never animated.
    const scen = scenarios.find((s) => s.id === forecast.scenario);
    $("#steps-sub").textContent =
      `Scenario: ${scen.label.toLowerCase()} — ${scen.description} Quotas for the rest of the current quarter are as announced.`;
    const origin = forecast.origin.premium;
    mount($("#steps"), raw(dataTable(
      [{ label: "Exercise", get: (s) => s.label }, { label: "Quota", num: true, get: (s) => number(s.quota) },
       { label: "p10", num: true, get: (s) => money(s.q10) }, { label: "Median", num: true, get: (s) => money(s.q50) },
       { label: "p90", num: true, get: (s) => money(s.q90) }, { label: "vs today", num: true, get: (s) => pct((s.q50 / origin - 1) * 100) }],
      forecast.steps,
    )));
  }

  function publish(forecast, a) {
    const scen = scenarios.find((s) => s.id === forecast.scenario);
    const end = forecast.steps[forecast.steps.length - 1];
    setView({ facts: [
      { label: "Current premium", value: `${money(forecast.origin.premium)} (${forecast.origin.label})` },
      { label: `Median, ${end.label}`, value: money(end.q50) },
      { label: "80% range", value: `${moneyShort(end.q10)}–${moneyShort(end.q90)}` },
      { label: "Recommendation", value: `${a.label} · ${CONVICTION[a.conviction].toLowerCase()}` },
      { label: "Supply scenario", value: scen.label },
    ] });
  }

  await update();
  return () => { [pulse.pressure, pulse.quota, fanChart].forEach((c) => c?.destroy()); };
}
