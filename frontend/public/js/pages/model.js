// Under the hood: a plain "why trust this?" summary first, then the full technical
// evaluation (leaderboard, error by horizon, predicted vs actual, TFT interpretability).

import { api } from "../api.js";
import { barList, columnChart, dataTable, lineChart } from "../charts.js";
import { replaceHash, setView } from "../context.js";
import { explain } from "../glossary.js";
import { swap } from "../motion.js";
import {
  CATEGORY_CODES, errorBox, exerciseDate, html, money, moneyShort, mount, onSegment, pct, raw, segmented, timeAgo,
} from "../util.js";

// Fixed identity colours for the three models compared by horizon.
const OURS = "hybrid";
const HORIZON_SERIES = [
  { model: "hybrid", color: "var(--cat-A)" },
  { model: "tft", color: "var(--cat-B)" },
  { model: "naive", color: "var(--cat-C)" },
];
const STALE_RUN_MS = 3 * 3600 * 1000;      // a "running" run older than this was interrupted

function runStatus(r) {
  if (r.status === "running" && Date.now() - new Date(r.created_at).getTime() > STALE_RUN_MS) return "interrupted";
  return r.status;
}

function trustSummary(board, byH, dm) {
  const ours = board.find((r) => r.model === OURS);
  const naive = board.find((r) => r.model === "naive");
  if (!ours) return html`<p class="muted">No evaluation for the hybrid model yet.</p>`;
  const h = (n) => byH.find((r) => r.model === OURS && r.horizon === n);
  const h1 = h(1);
  const h6 = h(6);
  const rank = board.indexOf(ours) + 1;
  const dmNaive = dm.naive?.p_value;
  const vsNaive = naive
    ? html`It beats the simplest method — assume the next premium equals today's
        ${explain("random-walk", "random walk")} — by ${money(naive.pinball - ours.pinball)} of pinball loss
        (${money(ours.pinball)} vs ${money(naive.pinball)})${dmNaive != null ? html`, a gap that ${dmNaive < 0.05 ? "is" : html`is <strong>not</strong>`} statistically significant (Diebold–Mariano p = ${dmNaive.toFixed(3)})` : ""}.
        COE premiums are very hard to predict, so treat the ranges as the main message, not the single median.`
    : "";
  return html`
    <div class="trust-grid mt-24">
      <div class="trust-item"><div class="trust-label">Model we use</div>
        <div class="trust-value">Hybrid: TFT + Box-Tiao ARIMAX ${explain("hybrid", "hybrid model")}</div>
        <div class="caption">${rank === 1 ? "Lowest error of" : `Ranked #${rank} of`} ${board.length} methods tested</div></div>
      <div class="trust-item"><div class="trust-label">Typical error ${explain("mape", "MAPE")}</div>
        <div class="trust-value">${pct(ours.mape, { sign: false })}</div>
        <div class="caption">${h1 && h6 ? `From ${pct(h1.mape, { sign: false })} one exercise ahead to ${pct(h6.mape, { sign: false })} six ahead` : "Median forecast vs actual, held-out data"}</div></div>
      <div class="trust-item"><div class="trust-label">80% range coverage ${explain("coverage", "interval coverage")}</div>
        <div class="trust-value">${pct(ours.coverage80, { sign: false })}</div>
        <div class="caption">of real results fell inside the 80% range (ideal: about 80%)</div></div>
      <div class="trust-item"><div class="trust-label">Compared against ${explain("backtest", "out-of-sample backtest")}</div>
        <div class="trust-value">${board.length - 1} other methods</div>
        <div class="caption">${board.filter((r) => r.model !== OURS).map((r) => r.label).join(", ")}</div></div>
    </div>
    <p class="small muted mt-16">${vsNaive}</p>`;
}

export async function render(root, { query = {} } = {}) {
  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Under the hood</p>
      <h1 class="headline">Honest numbers.</h1>
      <p class="subtitle">Every model is scored on the last three years of auctions it never saw, re-forecasting from every bidding exercise. COE premiums are close to a random walk, so that is the bar to clear.</p>
    </section>
    <section class="container mt-40" id="model-body"><div class="card card-lg"><div class="skeleton" style="height:300px"></div></div></section>`);

  let metrics;
  let interp;
  let runs;
  try {
    [metrics, interp, runs] = await Promise.all([api.get("/model/metrics"), api.get("/model/interpretability"), api.get("/model/runs")]);
  } catch (err) {
    mount(root.querySelector("#model-body"), errorBox(err));
    return undefined;
  }
  const charts = [];
  const runMetrics = metrics.run.metrics || {};
  const dm = runMetrics.diebold_mariano || {};
  const board = metrics.leaderboard;
  const best = board[0];
  const testStart = runMetrics.test_start;
  const ours = board.find((r) => r.model === OURS);

  mount(root.querySelector("#model-body"), html`
    <div class="card card-lg" data-anchor="model-summary">
      <h2 class="title">Why should I trust this model?</h2>
      <p class="card-sub">Scored on ${metrics.test_period.exercises || "held-out"} bidding exercises${testStart ? ` from ${testStart.month}` : ""} that the model never saw while training.</p>
      ${trustSummary(board, metrics.by_horizon, dm)}
    </div>

    <details class="tech-section mt-24" id="technical"${query.section === "technical" ? " open" : ""}>
      <summary><span class="title">View technical evaluation</span>
        <span class="caption">Leaderboard, error by horizon, predicted vs actual, TFT variables and attention, pipeline runs</span></summary>

    <div class="card card-lg mt-16" data-anchor="leaderboard">
      <div class="card-head"><div><h2 class="title">Leaderboard</h2>
        <p class="card-sub">Pinball loss ${explain("pinball", "pinball loss")} scores the whole forecast range (p10, p50, p90) in dollars; lower is better.
        ${testStart ? `Test period from ${testStart.month}, ${metrics.test_period.exercises} exercises, all five categories, 1–6 exercises ahead.` : ""}</p></div></div>
      ${raw(barList(board.map((r) => ({ label: r.label, value: r.pinball, display: money(r.pinball), highlight: r.model === OURS })), {}))}
      <div class="mt-24">${raw(dataTable([
        { label: "Model", get: (r) => r.label },
        { label: "Pinball ($)", num: true, get: (r) => money(r.pinball) },
        { label: "MAPE", num: true, get: (r) => pct(r.mape, { sign: false, digits: 1 }) },
        { label: "sMAPE", num: true, get: (r) => pct(r.smape, { sign: false, digits: 1 }) },
        { label: "MAE", num: true, get: (r) => money(r.mae) },
        { label: "80% coverage", num: true, get: (r) => pct(r.coverage80, { sign: false, digits: 1 }) },
        { label: "Direction", num: true, get: (r) => (r.direction == null ? "—" : pct(r.direction, { sign: false, digits: 1 })) },
        { label: "DM p-value vs ours", num: true, get: (r) => (r.model === OURS ? "—" : dm[r.model] ? dm[r.model].p_value.toFixed(3) : "—") },
      ], board))}</div>
      <p class="caption mt-16">Terms: MAPE ${explain("mape", "MAPE")} · sMAPE ${explain("smape", "sMAPE")} · 80% coverage ${explain("coverage", "interval coverage")} · direction ${explain("direction", "direction accuracy")} · DM p-value ${explain("diebold-mariano", "Diebold–Mariano test")}</p>
      <p class="caption mt-8">Our hybrid averages the TFT's and the Box-Tiao ARIMAX's quantiles with fixed equal weights. Direction counts only forecasts that call a move of more than 0.5%, so the random walk has no score. The Diebold–Mariano test compares each model's loss with the hybrid's across forecast origins; p &lt; 0.05 means the difference is statistically significant.
      ${best.model === OURS ? "The hybrid has the lowest loss." : `Lowest loss: ${best.label}.`}</p>
    </div>

    <div class="grid grid-2 mt-24">
      <div class="card" data-anchor="error-by-horizon">
        <div class="card-head"><div><h2 class="title">Error by horizon ${explain("horizon", "forecast horizon")}</h2>
          <p class="card-sub">Mean absolute percentage error, 1 to 6 exercises ahead. Errors grow the further ahead the model looks.</p></div></div>
        <ul class="legend">${HORIZON_SERIES.map((s) => html`<li><span class="key-line" style="background:${s.color}"></span>${board.find((b) => b.model === s.model)?.label || s.model}</li>`)}</ul>
        <div id="by-horizon"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2 class="title">Predicted vs actual</h2>
          <p class="card-sub" id="bt-sub">Out-of-sample hybrid forecasts made one exercise ahead.</p></div></div>
        <div class="row">${segmented("bt-cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), "A", "Category")}
          ${segmented("bt-h", [{ value: "1", label: "1 ahead" }, { value: "3", label: "3 ahead" }, { value: "6", label: "6 ahead" }], "1", "Horizon")}</div>
        <ul class="legend mt-16">
          <li><span class="key-line" style="background:var(--ink)"></span>Actual</li>
          <li><span class="key-line" style="background:var(--accent)"></span>Hybrid median</li>
          <li><span class="key-band" style="background:var(--accent-wash)"></span>80% range</li>
        </ul>
        <div id="backtest"></div>
      </div>
    </div>

    <div class="grid grid-2 mt-24">
      <div class="card">
        <div class="card-head"><div><h2 class="title">What the TFT looks at ${explain("variable-importance", "variable importance")}</h2>
          <p class="card-sub">Variable-selection weights averaged over the last two years. High weight means the model relies on it, not that it causes prices.</p></div>
          ${segmented("vsn", [{ value: "encoder", label: "Past inputs" }, { value: "decoder", label: "Known future" }], "encoder", "Input type")}</div>
        <div id="importance"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2 class="title">Where attention goes ${explain("attention", "attention weights")}</h2>
          <p class="card-sub">Average attention paid to each past exercise (1 = the latest).</p></div>
          ${segmented("att-cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), "A", "Category")}</div>
        <div id="attention"></div>
      </div>
    </div>

    <div class="card mt-24">
      <div class="card-head"><div><h2 class="title">Pipeline runs</h2>
        <p class="card-sub">The ML job re-trains after each bidding exercise (Kubernetes CronJob). Epochs are chosen by rolling time-series cross-validation.</p></div></div>
      ${raw(dataTable([
        { label: "Run", get: (r) => `#${r.id}` },
        { label: "Status", get: runStatus },
        { label: "Data through", get: (r) => (r.data_through ? `${r.data_through.slice(0, 7)} · ${r.last_bidding === 1 ? "1st" : "2nd"}` : "—") },
        { label: "Finished", get: (r) => (r.finished_at ? timeAgo(r.finished_at) : "—") },
        { label: "Duration", num: true, get: (r) => (r.duration_s ? `${Math.round(r.duration_s)} s` : "—") },
        { label: "Host", get: (r) => r.host || "—" },
      ], runs))}
      <p class="caption mt-8">Production TFT: ${runMetrics.production_epochs ?? "—"} epochs × ${metrics.run.params?.n_seeds ?? "—"} seeds, hidden size ${metrics.run.params?.tft?.hidden_size ?? "—"}, encoder ${metrics.run.params?.tft?.encoder_length ?? "—"} exercises; combined with a Box-Tiao ARIMAX refitted on all data. "Interrupted" marks a run that never finished (for example, a stopped container).</p>
    </div>
    </details>`);

  const details = root.querySelector("#technical");
  details.addEventListener("toggle", () => {
    replaceHash(details.open ? "#/model?section=technical" : "#/model");
  });
  setView({ facts: ours ? [
    { label: "Model", value: "Hybrid: TFT + Box-Tiao ARIMAX" },
    { label: "Typical error (MAPE)", value: pct(ours.mape, { sign: false }) },
    { label: "80% range coverage", value: pct(ours.coverage80, { sign: false }) },
  ] : [] });

  // ---- error by horizon ----
  const byH = metrics.by_horizon;
  charts.push(lineChart(root.querySelector("#by-horizon"), {
    xType: "linear", height: 260, label: "MAPE by forecast horizon",
    series: HORIZON_SERIES.map((s) => ({
      key: s.model, label: s.model, color: s.color,
      points: byH.filter((r) => r.model === s.model).map((r) => ({ x: r.horizon, y: r.mape })),
    })),
    yFormat: (v) => `${v.toFixed(0)}%`, xFormat: (v) => `${v}`, yZero: true,
    tooltip: (h) => ({ title: `${h} exercise${h > 1 ? "s" : ""} ahead`, rows: HORIZON_SERIES.map((s) => {
      const r = byH.find((x) => x.model === s.model && x.horizon === h);
      return { value: r ? pct(r.mape, { sign: false }) : "—", label: board.find((b) => b.model === s.model)?.label || s.model, color: s.color };
    }) }),
  }));

  // ---- predicted vs actual ----
  const bt = { cat: "A", h: "1" };
  let btChart = null;
  let latestBt = 0;
  async function drawBacktest({ animate = false } = {}) {
    const token = ++latestBt;
    const { cat, h } = bt;
    let data;
    try {
      data = await api.get(`/model/backtest/${cat}?model=${OURS}&horizon=${h}`);
    } catch (err) {
      if (token === latestBt) { btChart?.destroy(); btChart = null; mount(root.querySelector("#backtest"), errorBox(err)); }
      return;
    }
    if (token !== latestBt) return;
    const pts = data.points.map((p) => ({ ...p, x: exerciseDate(p.month, p.bidding_no) }));
    const byTime = new Map(pts.map((p) => [+p.x, p]));
    root.querySelector("#bt-sub").textContent = `Out-of-sample hybrid forecasts for Cat ${cat}, made ${h} exercise${h === "1" ? "" : "s"} ahead.`;
    const opts = {
      height: 240, label: "Predicted versus actual premium",
      series: [
        { key: "actual", label: "Actual", color: "var(--ink)", points: pts.map((p) => ({ x: p.x, y: p.actual })) },
        { key: "q50", label: "Median", color: "var(--accent)", points: pts.map((p) => ({ x: p.x, y: p.q50 })) },
      ],
      bands: [{ key: "band", color: "var(--accent)", opacity: 0.14, points: pts.map((p) => ({ x: p.x, lo: p.q10, hi: p.q90 })) }],
      zoom: true,
      yFormat: moneyShort,
      tooltip: (x) => {
        const p = byTime.get(+x);
        return p && { title: p.label, rows: [
          { value: money(p.actual), label: "actual", color: "var(--ink)" },
          { value: money(p.q50), label: "median", color: "var(--accent)" },
          { value: `${moneyShort(p.q10)}–${moneyShort(p.q90)}`, label: "80% range", color: "var(--accent-wash)" },
        ] };
      },
    };
    if (btChart) btChart.update(opts, { animate });
    else btChart = lineChart(root.querySelector("#backtest"), opts);
  }
  // Switching category or horizon morphs the lines rather than redrawing them.
  onSegment(root, "bt-cat", (c) => { bt.cat = c; drawBacktest({ animate: true }); });
  onSegment(root, "bt-h", (h) => { bt.h = h; drawBacktest({ animate: true }); });
  await drawBacktest();

  // ---- interpretability ----
  let firstImportance = true;
  function drawImportance(component) {
    const rows = [...(interp[component] || [])].sort((a, b) => b.importance - a.importance).slice(0, 10);
    const box = root.querySelector("#importance");
    swap(box, () => mount(box, rows.length ? raw(barList(rows.map((r, i) => ({
      label: r.label, value: r.importance, display: pct(r.importance * 100, { sign: false }), highlight: i === 0,
    })))) : html`<p class="muted small">No variable weights stored for this run.</p>`), { key: component, animate: !firstImportance, distance: 4 });
    firstImportance = false;
  }
  let attChart;
  function drawAttention(cat) {
    const rows = (interp.attention[cat] || []).slice().sort((a, b) => a.lag - b.lag);
    const items = rows.map((r) => ({ label: r.lag % 3 === 0 || r.lag === 1 ? String(r.lag) : "", title: `${r.lag} exercise${r.lag > 1 ? "s" : ""} back`,
                                     value: r.weight * 100, seriesLabel: "attention" }));
    if (attChart) { attChart.update(items, { animate: true }); return; }
    attChart = columnChart(root.querySelector("#attention"), {
      items, yFormat: (v) => `${v.toFixed(0)}%`, height: 240, label: "Attention by lag",
    });
  }
  onSegment(root, "vsn", drawImportance);
  onSegment(root, "att-cat", drawAttention);
  drawImportance("encoder");
  drawAttention("A");

  return () => [...charts, btChart, attChart].forEach((c) => c?.destroy());
}
