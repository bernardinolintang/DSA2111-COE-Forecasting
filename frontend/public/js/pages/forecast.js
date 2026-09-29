// Forecast: fan chart with supply scenarios, buy/wait advice, next-six table, market pulse.

import { api } from "../api.js";
import { columnChart, dataTable, lineChart } from "../charts.js";
import {
  CATEGORY_CODES, ICONS, errorBox, exerciseDate, html, money, moneyShort, mount, number, onSegment, pct, raw,
  segmented, store,
} from "../util.js";

const RANGES = [
  { value: "1", label: "1Y" }, { value: "3", label: "3Y" }, { value: "5", label: "5Y" }, { value: "0", label: "All" },
];

export async function render(root, { category = "A" } = {}) {
  category = CATEGORY_CODES.includes(category) ? category : "A";
  const state = { category, scenario: "base", years: store.get("coe-range", "1"), table: false };
  const charts = [];

  const [categories, scenarios] = await Promise.all([api.get("/categories"), api.get("/scenarios")]);
  const meta = categories.find((c) => c.code === category);

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Forecast</p>
      <h1 class="headline">${meta.name} · ${meta.title}</h1>
      <p class="subtitle">${meta.description}</p>
    </section>

    <section class="container">
      <div class="filters">
        <div class="filter"><span class="filter-label">Category</span>
          ${segmented("cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), category, "COE category")}</div>
        <div class="filter"><span class="filter-label">Next quarter's supply</span>
          ${segmented("scenario", scenarios.map((s) => ({ value: s.id, label: s.label })), "base", "Supply scenario")}</div>
        <div class="filter"><span class="filter-label">History</span>
          ${segmented("range", RANGES, state.years, "History range")}</div>
      </div>

      <div class="split">
        <div class="card card-lg" id="chart-card">
          <div class="card-head">
            <div><h2 class="title">Premium & forecast</h2><p class="card-sub" id="chart-sub">Loading…</p></div>
            <button class="btn btn-ghost btn-sm table-toggle" id="toggle-table" aria-pressed="false">Table view</button>
          </div>
          <ul class="legend">
            <li><span class="key-line" style="background:var(--ink)"></span>Actual premium</li>
            <li><span class="key-line" style="background:var(--accent)"></span>Median forecast</li>
            <li><span class="key-band" style="background:var(--accent-wash-2)"></span>50% range</li>
            <li><span class="key-band" style="background:var(--accent-wash)"></span>80% range</li>
          </ul>
          <div id="fan"></div>
          <div id="fan-table" hidden></div>
        </div>
        <div class="card card-lg" id="advice"><div class="skeleton" style="height:260px"></div></div>
      </div>

      <div class="card card-lg mt-24">
        <div class="card-head"><div><h2 class="title">Next six bidding exercises</h2>
          <p class="card-sub" id="steps-sub">Quantiles of the forecast distribution for each upcoming exercise.</p></div></div>
        <div id="steps"></div>
      </div>

      <div class="grid grid-2 mt-24">
        <div class="card"><div class="card-head"><div><h2 class="title">Bids per COE</h2>
          <p class="card-sub">Bids received ÷ quota, last two years. Above 1 means more bidders than certificates.</p></div></div>
          <div id="pressure"></div></div>
        <div class="card"><div class="card-head"><div><h2 class="title">Quota per exercise</h2>
          <p class="card-sub">COEs released each bidding exercise, last two years.</p></div></div>
          <div id="quota"></div></div>
      </div>

      <p class="mt-24 row"><a class="link-arrow" href="#/bid/${category}">Plan your bid</a>
        <a class="link-arrow" href="#/model">How accurate is this?</a></p>
    </section>`);

  onSegment(root, "cat", (c) => { location.hash = `#/forecast/${c}`; });
  onSegment(root, "scenario", (s) => { state.scenario = s; update(); });
  onSegment(root, "range", (y) => { state.years = y; store.set("coe-range", y); update(); });
  root.querySelector("#toggle-table").addEventListener("click", (e) => {
    state.table = !state.table;
    e.currentTarget.setAttribute("aria-pressed", String(state.table));
    e.currentTarget.textContent = state.table ? "Chart view" : "Table view";
    root.querySelector("#fan").hidden = state.table;
    root.querySelector("#fan-table").hidden = !state.table;
  });

  // Market pulse charts only depend on the category.
  api.get(`/history/${category}?years=2`).then((h) => {
    const pts = h.points;
    const every = Math.ceil(pts.length / 8);
    charts.push(columnChart(root.querySelector("#pressure"), {
      items: pts.map((p, i) => ({ label: i % every === 0 ? p.label.split(" · ")[0].replace(/ 20/, " '") : "",
                                  title: p.label, value: p.bids_received / Math.max(p.quota, 1), seriesLabel: "bids per COE" })),
      yFormat: (v) => v.toFixed(1), label: "Bids per COE", height: 200,
    }));
    charts.push(columnChart(root.querySelector("#quota"), {
      items: pts.map((p, i) => ({ label: i % every === 0 ? p.label.split(" · ")[0].replace(/ 20/, " '") : "",
                                  title: p.label, value: p.quota, seriesLabel: "COEs" })),
      yFormat: (v) => number(v), label: "Quota per exercise", height: 200, color: "var(--neutral-mark)",
    }));
  }).catch(() => {});

  async function update() {
    const fan = root.querySelector("#fan");
    fan.classList.add("chart-loading");
    try {
      const [history, forecast, advice] = await Promise.all([
        api.get(`/history/${category}?years=${state.years}`),
        api.get(`/forecast/${category}?scenario=${state.scenario}`),
        api.get(`/recommendation/${category}?scenario=${state.scenario}`),
      ]);
      renderFan(history, forecast);
      renderAdvice(advice);
      renderSteps(forecast);
    } catch (err) {
      mount(fan, errorBox(err));
    } finally {
      fan.classList.remove("chart-loading");
    }
  }

  let fanChart = null;

  function renderFan(history, forecast) {
    fanChart?.destroy();
    const hist = history.points.map((p) => ({ x: exerciseDate(p.month, p.bidding_no), y: p.premium, label: p.label }));
    const last = hist[hist.length - 1];
    const steps = forecast.steps.map((s) => ({ ...s, x: exerciseDate(s.month, s.bidding_no) }));
    const withOrigin = (lo, hi) => [{ x: last.x, lo: last.y, hi: last.y }, ...steps.map((s) => ({ x: s.x, lo: s[lo], hi: s[hi] }))];
    const byTime = new Map([...hist.map((p) => [+p.x, { type: "actual", ...p }]), ...steps.map((s) => [+s.x, { type: "fc", ...s }])]);

    root.querySelector("#chart-sub").textContent =
      `Last result ${money(last.y)} (${last.label}). Shaded: forecast ranges for the next six exercises.`;
    fanChart = lineChart(root.querySelector("#fan"), {
      label: `${meta.name} premium history and forecast`,
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
    });
    mount(root.querySelector("#fan-table"), raw(dataTable(
      [{ label: "Exercise", get: (r) => r.label }, { label: "Actual", num: true, get: (r) => (r.type === "actual" ? money(r.y) : "") },
       { label: "p10", num: true, get: (r) => (r.q10 ? money(r.q10) : "") }, { label: "Median", num: true, get: (r) => (r.q50 ? money(r.q50) : "") },
       { label: "p90", num: true, get: (r) => (r.q90 ? money(r.q90) : "") }],
      [...byTime.values()].reverse(),
    )));
  }

  function renderAdvice(a) {
    const wait = a.action === "wait";
    mount(root.querySelector("#advice"), html`
      <div class="advice ${wait ? "advice-wait" : "advice-buy"}">
        <p class="eyebrow" style="margin:0">Our read for ${meta.name}</p>
        <div class="advice-action">${raw(wait ? ICONS.clock : ICONS.check)}${a.headline}</div>
        <p>${a.summary}</p>
        <div>
          <div class="row-between small"><span class="muted">Confidence</span><strong>${Math.round(a.confidence_pct)}%</strong></div>
          <div class="meter mt-8" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(a.confidence_pct)}"
               aria-label="Confidence"><span style="width:${a.confidence_pct}%"></span></div>
        </div>
        <dl class="kv">
          <div><dt>Today</dt><dd>${moneyShort(a.current)}</dd></div>
          <div><dt>Median, ${a.horizon_label.split(" · ")[0]}</dt><dd>${moneyShort(a.horizon_q50)}</dd></div>
          <div><dt>Change</dt><dd>${pct(a.expected_change_pct)}</dd></div>
        </dl>
        <ul class="reasons">${a.reasons.map((r) => html`<li>${r}</li>`)}</ul>
        <p class="tiny">Rule: wait if the median one quarter ahead is ≥${Math.round(a.threshold_pct)}% below today. Lowest expected premium: ${money(a.cheapest_q50)} (${a.cheapest_label}).</p>
      </div>`);
  }

  function renderSteps(forecast) {
    const scen = scenarios.find((s) => s.id === forecast.scenario);
    root.querySelector("#steps-sub").textContent =
      `Scenario: ${scen.label.toLowerCase()} — ${scen.description} Quotas for the rest of the current quarter are as announced.`;
    const origin = forecast.origin.premium;
    mount(root.querySelector("#steps"), raw(dataTable(
      [{ label: "Exercise", get: (s) => s.label }, { label: "Quota", num: true, get: (s) => number(s.quota) },
       { label: "p10", num: true, get: (s) => money(s.q10) }, { label: "Median", num: true, get: (s) => money(s.q50) },
       { label: "p90", num: true, get: (s) => money(s.q90) }, { label: "vs today", num: true, get: (s) => pct((s.q50 / origin - 1) * 100) }],
      forecast.steps,
    )));
  }

  await update();
  return () => [...charts, fanChart].forEach((c) => c?.destroy());
}
