// Scenario Lab: how the forecast responds if next quarter's COE quota is higher
// or lower than today's.
//
// The model is run at -20%, -10%, as announced, +10% and +20%. All five runs are
// loaded once, so dragging the slider is instant: every whole percentage in
// between is a straight line between the two nearest runs (forecast-math.js; the
// API's ?quota_pct= does the same, and a test checks they agree). Nothing is
// extrapolated beyond the modelled range.
//
// The slider responds immediately; what it drives is smoothed: the expected
// premium counts to its new value and the chart morphs, with the as-announced
// median kept as a grey dashed line for comparison.

import { api } from "../api.js";
import { replaceHash, setPageActions, setView } from "../context.js";
import { drawFan, fanLegend, fanOptions } from "../fan.js";
import { interpolateSteps, scenarioDelta, scenarioLabel } from "../forecast-math.js";
import { explain } from "../glossary.js";
import { DURATION, animateNumber } from "../motion.js";
import { buildHash, clampQuota, scenarioPct } from "../route.js";
import {
  CATEGORY_CODES, errorBox, forecastId, html, money, mount, number, onSegment, pct, provenance, rangeShort, segmented,
} from "../util.js";

const signed = (n) => (n === 0 ? "0%" : `${n > 0 ? "+" : "−"}${Math.abs(n)}%`);
const quotaOf = (query) => clampQuota(query.quota ?? scenarioPct(query.scenario) ?? 0);

export async function render(root, { category = "A", query = {} } = {}, page = {}) {
  const [categories, scenarios] = await Promise.all([api.get("/categories"), api.get("/scenarios")]);
  const modelled = [...scenarios].sort((a, b) => a.quota_pct - b.quota_pct);       // -20 … +20
  const [min, max] = [modelled[0].quota_pct, modelled[modelled.length - 1].quota_pct];
  const state = { category: CATEGORY_CODES.includes(category) ? category : "A", pct: quotaOf(query) };
  const metaOf = (c) => categories.find((x) => x.code === c);

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Scenario Lab</p>
      <h1 class="headline">What if supply changes?</h1>
      <p class="subtitle">LTA decides how many COEs are released each quarter. Drag the slider to see how the forecast responds if next quarter's quota turns out higher or lower than today's.</p>
    </section>
    <section class="container">
      <div class="filters">
        <div class="filter"><span class="filter-label">Category</span>
          ${segmented("cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), state.category, "COE category")}</div>
      </div>
      <div class="split split-lab" id="lab" aria-busy="true">
        <div class="card card-lg" data-anchor="scenario-picker">
          <label class="lab-label" for="quota-range">Assumed quota change, next quarter ${explain("supply-scenario", "supply scenario")}</label>
          <div class="lab-readout"><output id="quota-out" for="quota-range">${signed(state.pct)}</output>
            <span class="muted small" id="quota-count"></span></div>
          <input class="range range-centre" id="quota-range" type="range" min="${min}" max="${max}" step="1" value="${state.pct}">
          <div class="range-scale" role="group" aria-label="Modelled scenarios">
            ${modelled.map((s) => html`<button type="button" data-quota="${s.quota_pct}" aria-pressed="${s.quota_pct === state.pct}"
              aria-label="${s.label}">${s.quota_pct === 0 ? "As announced" : signed(s.quota_pct)}</button>`)}
          </div>

          <div class="lab-result" aria-live="polite">
            <div class="fig-label">Expected premium <span class="fig-when" id="lab-when"></span> ${explain("median", "median forecast")}</div>
            <div class="lab-figure" id="lab-median">—</div>
            <div class="fig-delta" id="lab-delta">
              <span class="fig-cmp" hidden><span class="fig-arrow" aria-hidden="true"></span>
                <span class="fig-delta-amt"></span> <span class="fig-rest"></span></span>
              <span class="fig-base muted">Supply as announced: this is the baseline forecast.</span>
            </div>
          </div>
          <dl class="kv kv-2 mt-16">
            <div><dt>80% range by then</dt><dd id="lab-range">—</dd></div>
            <div><dt>Change vs today's premium</dt><dd id="lab-vs-today">—</dd></div>
          </dl>
          <p class="caption mt-16" id="lab-note" aria-live="polite" hidden></p>
          <p class="caption mt-16">The model was run at ${modelled.map((s) => (s.quota_pct === 0 ? "as announced" : signed(s.quota_pct))).join(", ")}.
            Values in between are interpolated between the two nearest runs. Quotas for the rest of the current quarter stay as announced.</p>
        </div>

        <div class="card card-lg" data-anchor="scenario-chart">
          <div class="card-head"><div><h2 class="title">Forecast under this scenario</h2>
            <p class="card-sub" id="lab-chart-sub" aria-live="polite">Loading…</p></div></div>
          ${fanLegend({ baseline: true })}
          <div id="lab-fan"><div class="skeleton" style="height:${window.innerWidth < 600 ? 280 : 340}px"></div></div>
        </div>
      </div>

      <div class="card card-lg mt-24" data-anchor="scenario-table">
        <div class="card-head"><div><h2 class="title">Scenarios side by side</h2>
          <p class="card-sub" id="steps-sub">The median and 80% range at the end of next quarter under each modelled supply level.</p></div></div>
        <div id="lab-table"><div class="skeleton" style="height:240px"></div></div>
        <div id="lab-provenance"></div>
      </div>
      <p class="mt-24 row"><a class="link-arrow" id="lab-forecast-link" href="#/forecast/${state.category}">Back to the forecast as announced</a>
        <a class="link-arrow" id="lab-policy-link" href="#/policy/${state.category}">What past quota changes did</a></p>
    </section>`);

  const $ = (sel) => root.querySelector(sel);
  const lab = $("#lab");
  const range = $("#quota-range");
  let data = null;               // { history, runs: [{ pct, steps }], base, origin, run }
  let chart = null;
  let loadToken = 0;
  let hashTimer;

  function paint({ animate = true, duration = DURATION.card } = {}) {
    if (!data) return;
    const { pct: q } = state;
    const steps = interpolateSteps(data.runs, q);
    const end = steps[steps.length - 1];
    const baseEnd = data.base[data.base.length - 1];
    const label = scenarioLabel(q);
    const exact = data.runs.some((r) => r.pct === q);

    range.value = q;
    range.setAttribute("aria-valuetext", `${label}${exact ? "" : " (interpolated)"}`);
    const at = ((q - min) / (max - min)) * 100;
    const mid = ((0 - min) / (max - min)) * 100;
    const [a, b] = at < mid ? [at, mid] : [mid, at];
    range.style.background = `linear-gradient(90deg, var(--surface-sunk) ${a}%, var(--accent) ${a}%, var(--accent) ${b}%, var(--surface-sunk) ${b}%)`;
    $("#quota-out").textContent = signed(q);
    root.querySelectorAll("[data-quota]").forEach((btn) => btn.setAttribute("aria-pressed", String(Number(btn.dataset.quota) === q)));
    $("#quota-count").textContent = q === 0
      ? `${number(end.quota)} COEs per exercise, as announced`
      : `${number(end.quota)} COEs per exercise (${number(baseEnd.quota)} as announced)`;

    $("#lab-when").textContent = `(median, ${end.label})`;
    animateNumber($("#lab-median"), end.q50, { format: money, animate, duration });
    $("#lab-range").textContent = rangeShort(end.q10, end.q90);
    $("#lab-vs-today").textContent = pct((end.q50 / data.origin.premium - 1) * 100);

    // "↓ $1,685 relative to as announced (−1.3%)": the amount counts; the words
    // around it only change when the direction does.
    const d = scenarioDelta(end.q50, baseEnd.q50, q);
    const deltaEl = $("#lab-delta");
    const cmp = deltaEl.querySelector(".fig-cmp");
    cmp.hidden = !d;
    deltaEl.querySelector(".fig-base").hidden = Boolean(d);
    deltaEl.className = `fig-delta${d ? ` ${d.dir}` : ""}`;
    if (d) {
      deltaEl.querySelector(".fig-arrow").textContent = d.dir === "down" ? "↓" : d.dir === "up" ? "↑" : "≈";
      animateNumber(deltaEl.querySelector(".fig-delta-amt"), Math.abs(d.diff), { format: money, animate, duration });
      deltaEl.querySelector(".fig-rest").textContent =
        `${d.dir === "flat" ? "difference from" : d.dir === "down" ? "lower than" : "higher than"} as announced (${pct(d.rel)})`;
    }
    const note = $("#lab-note");
    note.hidden = !d;
    if (d) note.textContent = `${d.text}${exact ? "" : " This point is interpolated between two model runs."}`;

    const { opts, last } = fanOptions({
      history: data.history, steps, baseline: q ? data.base : null, name: `${metaOf(state.category).name} (${label})`,
      height: window.innerWidth < 600 ? 280 : 340, startZoomed: true,
    });
    $("#lab-chart-sub").textContent = q === 0
      ? `${metaOf(state.category).name} with supply as announced. Move the slider to compare.`
      : `${metaOf(state.category).name} with ${label.toLowerCase()} next quarter, against the forecast as announced (grey).`;
    if (chart) chart.update(opts, { animate, duration });
    else chart = drawFan($("#lab-fan"), opts, last);

    paintTable(steps, q, exact);
    clearTimeout(hashTimer);                  // browsers throttle rapid history updates
    const cat = state.category;
    hashTimer = setTimeout(() => {
      if (root.isConnected && cat === state.category) replaceHash(buildHash({ page: "scenario", category: cat, quota: q }));
    }, 250);
    setView({
      category: state.category, quota_pct: q,
      facts: [
        { label: "Supply scenario", value: `${label}${exact ? "" : " (interpolated)"}` },
        { label: `Median, ${end.label}`, value: money(end.q50) },
        { label: "80% range", value: rangeShort(end.q10, end.q90) },
        ...(d ? [{ label: "vs as announced", value: `${d.diff < 0 ? "−" : "+"}${money(Math.abs(d.diff))}` }] : []),
        { label: "Latest premium", value: `${money(data.origin.premium)} (${data.origin.label})` },
      ],
    });
  }

  function paintTable(current, q, exact) {
    const baseEnd = data.base[data.base.length - 1];
    const rows = data.runs.map((r) => ({ pct: r.pct, steps: r.steps, label: scenarioLabel(r.pct), mine: r.pct === q }));
    if (!exact) rows.push({ pct: q, steps: current, label: `${scenarioLabel(q)} (your scenario, interpolated)`, mine: true });
    rows.sort((x, y) => x.pct - y.pct);
    mount($("#lab-table"), html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Scenario</th><th class="num">Quota per exercise</th><th class="num">Median</th>
        <th class="num">vs as announced</th><th class="num">80% range</th></tr></thead>
      <tbody>${rows.map((r) => {
        const end = r.steps[r.steps.length - 1];
        return html`<tr class="${r.mine ? "highlight" : ""}"${r.mine ? html` aria-current="true"` : ""}><td class="wrap">${r.label}</td>
          <td class="num">${number(end.quota)}</td><td class="num">${money(end.q50)}</td>
          <td class="num">${r.pct === 0 ? "—" : pct((end.q50 / baseEnd.q50 - 1) * 100)}</td>
          <td class="num">${rangeShort(end.q10, end.q90)}</td></tr>`;
      })}</tbody></table></div>`);
  }

  function setQuota(value, opts) {
    const q = clampQuota(value);
    if (q === state.pct && data) return;
    state.pct = q;
    paint(opts);
  }

  range.addEventListener("input", () => setQuota(range.value, { duration: DURATION.micro }));
  root.querySelector(".range-scale").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quota]");
    if (b) setQuota(b.dataset.quota);
  });
  const press = (value) => root.querySelectorAll('[data-seg="cat"] button')
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
  onSegment(root, "cat", (c) => { location.hash = buildHash({ page: "scenario", category: c, quota: state.pct }); });
  $('[data-seg="cat"]').addEventListener("pointerover", (e) => {
    const c = e.target.closest("button[data-value]")?.dataset.value;
    if (c && c !== state.category) api.prefetch(...modelled.map((s) => `/forecast/${c}?scenario=${s.id}`), `/history/${c}?years=1`);
  });

  async function load() {
    const token = ++loadToken;
    const cat = state.category;
    lab.setAttribute("aria-busy", "true");
    lab.classList.add("is-loading");
    try {
      const [history, ...forecasts] = await Promise.all([
        api.get(`/history/${cat}?years=1`), ...modelled.map((s) => api.get(`/forecast/${cat}?scenario=${s.id}`)),
      ]);
      if (token !== loadToken || !root.isConnected) return;
      const runs = modelled.map((s, i) => ({ pct: s.quota_pct, steps: forecasts[i].steps }));
      const base = forecasts[modelled.findIndex((s) => s.quota_pct === 0)];
      const firstLoad = !data;
      data = { history: history.points, runs, base: base.steps, origin: base.origin, run: base.run };
      $("#lab-forecast-link").href = `#/forecast/${cat}`;
      $("#lab-policy-link").href = `#/policy/${cat}`;
      mount($("#lab-provenance"), provenance({ run: base.run, dataThrough: base.origin.label, id: forecastId(cat, base.steps[0], base.run) }));
      paint({ animate: !firstLoad, duration: DURATION.route });
    } catch (err) {
      if (token !== loadToken || !root.isConnected) return;
      chart?.destroy();
      chart = null;
      data = null;
      mount($("#lab-fan"), errorBox(err, "This scenario couldn't be loaded"));
      mount($("#lab-table"), "");
      $("#lab-chart-sub").textContent = "";
    } finally {
      if (token === loadToken) { lab.removeAttribute("aria-busy"); lab.classList.remove("is-loading"); }
    }
  }

  page.navigate = ({ category: c, query: q = {} }) => {
    const next = CATEGORY_CODES.includes(c) ? c : "A";
    press(next);
    const quota = quotaOf(q);
    if (next === state.category) { setQuota(quota); return true; }
    state.category = next;
    state.pct = quota;
    setView({ category: next, quota_pct: quota, facts: [] });
    load();
    return true;
  };
  // The analyst can set the slider in place: a modelled scenario id or a percentage.
  setPageActions({ setQuota: (value) => setQuota(typeof value === "string" && scenarioPct(value) != null ? scenarioPct(value) : value) });
  setView({ category: state.category, quota_pct: state.pct });

  await load();
  return () => { clearTimeout(hashTimer); chart?.destroy(); };
}
