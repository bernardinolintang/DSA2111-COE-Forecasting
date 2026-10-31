// The forecast "fan": recorded premiums as a solid line, the median forecast as
// a dashed line, and the 50% / 80% ranges as shaded bands. One builder for the
// Overview, the Forecast page and the Scenario Lab, so they always read the same.

import { lineChart } from "./charts.js";
import { DURATION, reducedMotion } from "./motion.js";
import { exerciseDate, html, money, moneyShort, rangeShort } from "./util.js";
import { explain } from "./glossary.js";

/** The legend that goes with fanOptions(). */
export function fanLegend({ baseline = false } = {}) {
  return html`<ul class="legend">
    <li><span class="key-line" style="background:var(--ink)"></span>Recorded premium</li>
    <li><span class="key-line key-dash" style="color:var(--accent)"></span>Most likely ${explain("median", "median forecast")}</li>
    <li><span class="key-band" style="background:var(--accent-wash-2)"></span>50% range ${explain("range-50", "50% range")}</li>
    <li><span class="key-band" style="background:var(--accent-wash)"></span>80% range ${explain("range-80", "80% range")}</li>
    ${baseline ? html`<li><span class="key-line key-dash" style="color:var(--ink-3)"></span>Median as announced</li>` : ""}
  </ul>`;
}

/**
 * Chart options for a history + forecast fan.
 *  history: [{ month, bidding_no, premium, label }]   steps: forecast steps (q10…q90)
 *  baseline: optional steps of the as-announced forecast, drawn as a grey dashed line
 * Returns { opts, last, rows } (rows: every point, newest first, for the table view).
 */
export function fanOptions({ history, steps, name, height, baseline = null, markers = [], zoom = true, startZoomed = false }) {
  // this turns history and forecast into chart points so that both can share one time axis
  const hist = history.map((p) => ({ x: exerciseDate(p.month, p.bidding_no), y: p.premium, label: p.label }));
  const last = hist[hist.length - 1];
  const fc = steps.map((s) => ({ ...s, x: exerciseDate(s.month, s.bidding_no) }));
  const base = baseline ? baseline.map((s) => ({ x: exerciseDate(s.month, s.bidding_no), y: s.q50 })) : null;
  // this starts each band at the latest result so that the fan opens from one point
  const withOrigin = (lo, hi) => [{ x: last.x, lo: last.y, hi: last.y }, ...fc.map((s) => ({ x: s.x, lo: s[lo], hi: s[hi] }))];
  // this indexes every point by time so that the tooltip can find it fast
  const byTime = new Map([...hist.map((p) => [+p.x, { type: "actual", ...p }]), ...fc.map((s) => [+s.x, { type: "fc", ...s }])]);
  const baseAt = base ? new Map(base.map((p) => [+p.x, p.y])) : null;

  const opts = {
    label: `${name} premium history and forecast`,
    height,
    series: [
      { key: "actual", label: "Recorded", color: "var(--ink)", width: 2.25, points: hist },
      ...(base ? [{ key: "baseline", label: "As announced", color: "var(--ink-3)", dash: "2 5", points: [{ x: last.x, y: last.y }, ...base] }] : []),
      { key: "median", label: "Most likely", color: "var(--accent)", width: 2.25, dash: "7 5",
        points: [{ x: last.x, y: last.y }, ...fc.map((s) => ({ x: s.x, y: s.q50 }))], endDot: true },
    ],
    bands: [
      { key: "p10-p90", color: "var(--accent)", opacity: 0.13, points: withOrigin("q10", "q90") },
      { key: "p25-p75", color: "var(--accent)", opacity: 0.22, points: withOrigin("q25", "q75") },
    ],
    now: last.x, nowLabel: "Latest",
    xMarks: fc.map((s) => s.x),
    markers,
    zoom, startZoomed,
    // "Zoom to forecast" frames the last half-year and the six forecast exercises so that the fan
    // is easy to read
    focus: fc.length ? { x0: hist[Math.max(0, hist.length - 13)].x, x1: fc[fc.length - 1].x, label: "Zoom to forecast" } : null,
    yFormat: moneyShort,
    // this builds the tooltip for the point under the cursor so that recorded and forecast points
    // read differently
    tooltip: (x) => {
      const d = byTime.get(+x);
      if (!d) return null;
      if (d.type === "actual") {
        return { title: d.label, rows: [{ value: money(d.y), label: "recorded premium", color: "var(--ink)" }] };
      }
      return { title: `${d.label} · forecast`, rows: [
        { value: money(d.q50), label: "median forecast", color: "var(--accent)" },
        { value: rangeShort(d.q25, d.q75), label: "50% range", color: "var(--accent-wash-2)" },
        { value: rangeShort(d.q10, d.q90), label: "80% range", color: "var(--accent-wash)" },
        ...(baseAt?.has(+x) ? [{ value: money(baseAt.get(+x)), label: "median as announced", color: "var(--ink-3)" }] : []),
      ] };
    },
  };
  return { opts, last, rows: [...byTime.values()].reverse() };
}

/** History only: what the charts fall back to when no forecast is available. */
export function historyOptions({ history, name, height, markers = [] }) {
  // this keeps the same line style as the fan so that the chart looks the same with no forecast
  const hist = history.map((p) => ({ x: exerciseDate(p.month, p.bidding_no), y: p.premium, label: p.label }));
  const byTime = new Map(hist.map((p) => [+p.x, p]));
  return {
    label: `${name} premium history`, height, zoom: true, markers, bands: [], xMarks: [], now: null, focus: null,
    series: [{ key: "actual", label: "Recorded", color: "var(--ink)", width: 2.25, points: hist }],
    yFormat: moneyShort,
    tooltip: (x) => {
      const p = byTime.get(+x);
      return p ? { title: p.label, rows: [{ value: money(p.y), label: "recorded premium", color: "var(--ink)" }] } : null;
    },
  };
}

/**
 * Create the chart. On first paint the forecast fans out from the latest result
 * (history is drawn as is); with reduced motion it simply appears.
 */
export function drawFan(container, opts, last) {
  // this starts the forecast flat on the latest result then opens it so that the fan appears to
  // grow out of today
  if (reducedMotion() || !last) return lineChart(container, opts);
  const fanned = new Set(["median", "baseline"]);
  const flat = (pts) => pts.map((p) => ("lo" in p ? { ...p, lo: last.y, hi: last.y } : { ...p, y: last.y }));
  const chart = lineChart(container, {
    ...opts,
    series: opts.series.map((s) => (fanned.has(s.key) ? { ...s, points: flat(s.points) } : s)),
    bands: opts.bands.map((b) => ({ ...b, points: flat(b.points) })),
  });
  chart.update(opts, { animate: true, duration: DURATION.route + 120 });
  return chart;
}
