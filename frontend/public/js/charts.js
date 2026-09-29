// Dependency-free SVG charts.
//
// Conventions (see the dataviz guidelines followed by this project):
//  * 2px lines with round joins, bands as ~10-20% washes of the series colour
//  * hairline, solid, recessive gridlines; one y-axis only
//  * a crosshair that snaps to the nearest x, and ONE tooltip listing every series
//  * columns ≤ 24px wide with 4px rounded data-ends, square at the baseline
//  * text always uses ink tokens, never the series colour
// Every chart re-renders on resize (ResizeObserver) and is keyboard navigable.

import { esc } from "./util.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// Scales & ticks
// ---------------------------------------------------------------------------
function linear(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

export function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { ticks, min: lo, max: hi };
}

function timeTicks(t0, t1, maxTicks) {
  const years = (t1 - t0) / (365.25 * 864e5);
  const ticks = [];
  if (years > 2.5) {
    const step = Math.max(1, Math.ceil(years / maxTicks));
    const first = new Date(t0).getUTCFullYear() + 1;
    for (let y = first; Date.UTC(y, 0, 1) <= t1; y += step) {
      ticks.push({ value: Date.UTC(y, 0, 1), label: String(y) });
    }
  } else {
    const months = years * 12;
    const step = months > 18 ? 6 : months > 8 ? 3 : 1;
    const d = new Date(t0);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth() + 1;
    while (Date.UTC(y, m, 1) <= t1) {
      if (m % step === 0) {
        const v = Date.UTC(y, m, 1);
        ticks.push({ value: v, label: new Date(v).toLocaleDateString("en-SG", { month: "short", year: "2-digit", timeZone: "UTC" }) });
      }
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
  }
  return ticks;
}

const path = (points) => points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

// ---------------------------------------------------------------------------
// Tooltip (DOM, filled with textContent only)
// ---------------------------------------------------------------------------
function makeTooltip(container) {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "status");
  container.appendChild(tip);
  return {
    show(content, x, y, bounds) {
      tip.replaceChildren();
      const title = document.createElement("div");
      title.className = "tt-title";
      title.textContent = content.title;
      tip.appendChild(title);
      for (const row of content.rows) {
        const r = document.createElement("div");
        r.className = "tt-row";
        const key = document.createElement("span");
        key.className = "tt-key";
        key.style.background = row.color || "transparent";
        const value = document.createElement("span");
        value.className = "tt-value";
        value.textContent = row.value;
        const label = document.createElement("span");
        label.className = "tt-label";
        label.textContent = row.label;
        r.append(key, value, label);
        tip.appendChild(r);
      }
      const w = tip.offsetWidth || 180;
      const left = x + 16 + w > bounds ? x - w - 16 : x + 16;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, y)}px`;
      tip.classList.add("show");
    },
    hide() { tip.classList.remove("show"); },
  };
}

function observe(container, draw) {
  let frame;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); });
  ro.observe(container);
  return () => ro.disconnect();
}

// ---------------------------------------------------------------------------
// Time / line chart with optional bands, markers and a crosshair
// ---------------------------------------------------------------------------
/**
 * opts:
 *  series:  [{ key, label, color, points: [{x, y}], width? }]
 *  bands:   [{ key, color, opacity, points: [{x, lo, hi}] }]
 *  markers: [{ x, label }]            vertical hairlines (e.g. policy events)
 *  now:     x                         a "today" divider
 *  xType:   "time" (x = Date) | "linear"
 *  yFormat, xFormat(x) for ticks/tooltip; tooltip(x) -> {title, rows}
 *  height, yZero (include 0), label (aria)
 */
export function lineChart(container, opts) {
  const o = { height: 320, xType: "time", yFormat: String, xFormat: String, series: [], bands: [],
              markers: [], label: "Chart", ...opts };
  container.classList.add("chart");
  container.replaceChildren();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", o.label);
  svg.setAttribute("tabindex", "0");
  container.appendChild(svg);
  const tip = makeTooltip(container);

  const toNum = (x) => (o.xType === "time" ? +x : x);
  const xsAll = [...new Set([
    ...o.series.flatMap((s) => s.points.map((p) => toNum(p.x))),
    ...o.bands.flatMap((b) => b.points.map((p) => toNum(p.x))),
  ])].sort((a, b) => a - b);
  const lookup = o.series.map((s) => new Map(s.points.map((p) => [toNum(p.x), p.y])));
  let geometry = null;
  let active = -1;

  function draw() {
    const W = container.clientWidth;
    if (!W || !xsAll.length) return;
    const H = o.height;
    const compact = W < 520;
    const m = { top: o.markers.length && !compact ? 40 : 12, right: 12, bottom: 28, left: compact ? 46 : 58 };
    const yVals = [
      ...o.series.flatMap((s) => s.points.map((p) => p.y)),
      ...o.bands.flatMap((b) => b.points.flatMap((p) => [p.lo, p.hi])),
    ].filter((v) => v != null && Number.isFinite(v));
    let yMin = Math.min(...yVals);
    let yMax = Math.max(...yVals);
    if (o.yZero) yMin = Math.min(0, yMin);
    const pad = (yMax - yMin) * 0.06 || 1;
    const nice = o.yDomain                       // fixed domain, e.g. [0, 100] for probabilities
      ? niceTicks(o.yDomain[0], o.yDomain[1], compact ? 4 : 5)
      : niceTicks(o.yZero ? yMin : yMin - pad, yMax + pad, compact ? 4 : 5);
    const x = linear(xsAll[0], xsAll[xsAll.length - 1], m.left, W - m.right);
    const y = linear(nice.min, nice.max, H - m.bottom, m.top);
    geometry = { x, y, m, W, H };

    const parts = [];
    for (const t of nice.ticks) {
      const yy = Math.round(y(t)) + 0.5;
      parts.push(`<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${esc(o.yFormat(t))}</text>`);
    }
    const xTicks = o.xType === "time"
      ? timeTicks(xsAll[0], xsAll[xsAll.length - 1], compact ? 4 : 8)
      : niceTicks(xsAll[0], xsAll[xsAll.length - 1], compact ? 4 : 6).ticks
          .filter((v) => v >= xsAll[0] && v <= xsAll[xsAll.length - 1]).map((v) => ({ value: v, label: o.xFormat(v) }));
    for (const t of xTicks) {
      parts.push(`<text x="${x(t.value).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(t.label)}</text>`);
    }
    parts.push(`<line class="baseline" x1="${m.left}" x2="${W - m.right}" y1="${H - m.bottom + 0.5}" y2="${H - m.bottom + 0.5}"/>`);

    for (const b of o.bands) {
      const pts = b.points.filter((p) => p.lo != null && p.hi != null);
      if (!pts.length) continue;
      const upper = pts.map((p) => [x(toNum(p.x)), y(p.hi)]);
      const lower = pts.map((p) => [x(toNum(p.x)), y(p.lo)]).reverse();
      parts.push(`<path d="${path(upper)}${path(lower).replace("M", "L")}Z" fill="${b.color}" fill-opacity="${b.opacity ?? 0.14}"/>`);
    }
    if (o.now != null) {
      const nx = Math.round(x(toNum(o.now))) + 0.5;
      parts.push(`<line class="now-line" x1="${nx}" x2="${nx}" y1="${m.top}" y2="${H - m.bottom}"/>`);
      parts.push(`<text x="${nx + 6}" y="${m.top + 11}" class="marker-label">${esc(o.nowLabel || "Now")}</text>`);
    }
    // Marker labels go in two staggered rows; a label that would still collide is
    // left out (the marker line stays, and the full list is shown beside the chart).
    const rowEnds = [-Infinity, -Infinity];
    for (const mk of o.markers) {
      const mx = Math.round(x(toNum(mk.x))) + 0.5;
      if (mx < m.left || mx > W - m.right) continue;
      const labelW = String(mk.label).length * 6.2;
      const left = Math.min(Math.max(mx - labelW / 2, m.left), W - m.right - labelW);
      const row = compact ? -1 : rowEnds.findIndex((end) => left > end + 8);
      parts.push(`<line class="marker-line" x1="${mx}" x2="${mx}" y1="${row === 1 ? m.top - 18 : m.top - 4}" y2="${H - m.bottom}"/>`);
      if (row >= 0) {
        parts.push(`<text x="${left}" y="${m.top - 8 - row * 14}" class="marker-label">${esc(mk.label)}</text>`);
        rowEnds[row] = left + labelW;
      }
    }
    for (const s of o.series) {
      const pts = s.points.filter((p) => p.y != null).map((p) => [x(toNum(p.x)), y(p.y)]);
      if (pts.length > 1) {
        parts.push(`<path class="series-line" d="${path(pts)}" stroke="${s.color}" stroke-width="${s.width || 2}"/>`);
      }
      if (s.endDot && pts.length) {
        const [ex, ey] = pts[pts.length - 1];
        parts.push(`<circle cx="${ex}" cy="${ey}" r="4.5" fill="${s.color}" class="hover-dot"/>`);
      }
    }
    for (const p of o.points || []) {
      parts.push(`<circle cx="${x(toNum(p.x))}" cy="${y(p.y)}" r="${p.r || 6}" fill="${p.color}" class="hover-dot"/>`);
    }
    parts.push(`<g class="hover" style="display:none"><line class="crosshair" y1="${m.top}" y2="${H - m.bottom}"/>${
      o.series.map((s) => `<circle r="4.5" fill="${s.color}" class="hover-dot"/>`).join("")}</g>`);
    parts.push(`<rect class="hit" x="${m.left}" y="0" width="${W - m.left - m.right}" height="${H}"/>`);

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);
    svg.innerHTML = parts.join("");
    if (active >= 0) highlight(active);
  }

  function highlight(i) {
    if (!geometry || i < 0) return;
    active = i;
    const xv = xsAll[i];
    const { x, y } = geometry;
    const g = svg.querySelector(".hover");
    g.style.display = "";
    const cx = Math.round(x(xv)) + 0.5;
    const line = g.querySelector("line");
    line.setAttribute("x1", cx);
    line.setAttribute("x2", cx);
    g.querySelectorAll("circle").forEach((c, k) => {
      const v = lookup[k].get(xv);
      c.style.display = v == null ? "none" : "";
      if (v != null) { c.setAttribute("cx", x(xv)); c.setAttribute("cy", y(v)); }
    });
    const content = o.tooltip ? o.tooltip(o.xType === "time" ? new Date(xv) : xv, i) : null;
    if (content) tip.show(content, x(xv), geometry.m.top, geometry.W);
  }

  function clear() {
    active = -1;
    const g = svg.querySelector(".hover");
    if (g) g.style.display = "none";
    tip.hide();
  }

  function nearest(px) {
    const { x } = geometry;
    let lo = 0;
    let hi = xsAll.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x(xsAll[mid]) < px) lo = mid; else hi = mid;
    }
    return Math.abs(x(xsAll[lo]) - px) <= Math.abs(x(xsAll[hi]) - px) ? lo : hi;
  }

  svg.addEventListener("pointermove", (e) => {
    if (!geometry) return;
    const rect = svg.getBoundingClientRect();
    highlight(nearest((e.clientX - rect.left) * (geometry.W / rect.width)));
  });
  svg.addEventListener("pointerleave", clear);
  svg.addEventListener("blur", clear);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const start = active < 0 ? xsAll.length - 1 : active;
    highlight(Math.min(xsAll.length - 1, Math.max(0, start + (e.key === "ArrowRight" ? 1 : -1))));
  });

  const stop = observe(container, draw);
  return { destroy: stop };
}

// ---------------------------------------------------------------------------
// Column chart (one series) with per-bar tooltips
// ---------------------------------------------------------------------------
/** items: [{ label, value, color?, title? }] */
export function columnChart(container, { items, height = 220, yFormat = String, color = "var(--accent)",
                                         label = "Column chart", tickEvery = 1 }) {
  container.classList.add("chart");
  container.replaceChildren();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  container.appendChild(svg);
  const tip = makeTooltip(container);

  function draw() {
    const W = container.clientWidth;
    if (!W || !items.length) return;
    const m = { top: 12, right: 8, bottom: 26, left: 48 };
    const max = Math.max(...items.map((d) => d.value));
    const nice = niceTicks(0, max, 4);
    const y = linear(0, nice.max, height - m.bottom, m.top);
    const band = (W - m.left - m.right) / items.length;
    const barW = Math.min(24, Math.max(2, band - 2));             // 2px surface gap between bars
    const parts = [];
    for (const t of nice.ticks) {
      const yy = Math.round(y(t)) + 0.5;
      parts.push(`<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${esc(yFormat(t))}</text>`);
    }
    items.forEach((d, i) => {
      const cx = m.left + band * i + band / 2;
      const top = y(d.value);
      const h = Math.max(0, height - m.bottom - top);
      const r = Math.min(4, barW / 2, h);
      const x0 = cx - barW / 2;
      const base = height - m.bottom;
      // Rounded data-end, square at the baseline.
      const shape = `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${base}Z`;
      parts.push(`<path class="bar" data-i="${i}" tabindex="0" d="${shape}" fill="${d.color || color}"/>`);
      parts.push(`<rect class="hit" data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${height - m.top - m.bottom}" style="cursor:default"/>`);
      if (i % tickEvery === 0) {
        parts.push(`<text x="${cx}" y="${height - 8}" text-anchor="middle">${esc(d.label)}</text>`);
      }
    });
    parts.push(`<line class="baseline" x1="${m.left}" x2="${W - m.right}" y1="${height - m.bottom + 0.5}" y2="${height - m.bottom + 0.5}"/>`);
    svg.setAttribute("viewBox", `0 0 ${W} ${height}`);
    svg.setAttribute("height", height);
    svg.innerHTML = parts.join("");
    svg.dataset.band = band;
    svg.dataset.left = m.left;
    svg.dataset.width = W;
  }

  function show(i) {
    const d = items[i];
    if (!d) return;
    const band = +svg.dataset.band;
    const cx = +svg.dataset.left + band * i + band / 2;
    tip.show({ title: d.title || d.label, rows: [{ value: yFormat(d.value), label: d.seriesLabel || "", color: d.color || color }] },
      cx, 8, +svg.dataset.width);
  }
  svg.addEventListener("pointermove", (e) => {
    const i = e.target.closest("[data-i]")?.dataset.i;
    if (i == null) tip.hide(); else show(+i);
  });
  svg.addEventListener("pointerleave", () => tip.hide());
  svg.addEventListener("focusin", (e) => { const i = e.target.dataset.i; if (i != null) show(+i); });
  svg.addEventListener("focusout", () => tip.hide());

  const stop = observe(container, draw);
  return { destroy: stop };
}

// ---------------------------------------------------------------------------
// Sparkline: history in the accent, forecast median as a faded continuation
// ---------------------------------------------------------------------------
export function sparkline(values, forecast = [], { width = 220, height = 44 } = {}) {
  const all = [...values, ...forecast];
  if (all.length < 2) return "";
  const min = Math.min(...all);
  const max = Math.max(...all);
  const x = linear(0, all.length - 1, 2, width - 6);
  const y = linear(min, max === min ? min + 1 : max, height - 4, 4);
  const hist = values.map((v, i) => [x(i), y(v)]);
  const fut = [hist[hist.length - 1], ...forecast.map((v, i) => [x(values.length + i), y(v)])];
  const [ex, ey] = hist[hist.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${path(hist)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${forecast.length ? `<path d="${path(fut)}" fill="none" stroke="var(--accent)" stroke-opacity="0.35" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` : ""}
    <circle cx="${ex}" cy="${ey}" r="3.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Horizontal bar list (HTML): label · bar · value, sorted by the caller
// ---------------------------------------------------------------------------
/** rows: [{ label, value, display, color?, highlight? }] */
export function barList(rows, { max } = {}) {
  const top = max ?? Math.max(...rows.map((r) => r.value), 1e-9);
  return `<div class="barlist" role="list">${rows.map((r) => `
    <div class="barlist-row${r.highlight ? " is-highlight" : ""}" role="listitem" title="${esc(r.label)}: ${esc(r.display)}">
      <span class="barlist-label">${esc(r.label)}</span>
      <span class="barlist-track"><span class="barlist-bar" style="width:${Math.max(1.5, (r.value / top) * 100)}%;background:${
        r.color || (r.highlight ? "var(--accent)" : "var(--neutral-mark)")}"></span></span>
      <span class="barlist-value">${esc(r.display)}</span>
    </div>`).join("")}</div>`;
}

/** A simple accessible table, used as every chart's "table view". */
export function dataTable(columns, rows) {
  return `<div class="table-wrap"><table class="data"><thead><tr>${
    columns.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? "num" : ""}">${esc(c.get(r))}</td>`).join("")}</tr>`).join("")
  }</tbody></table></div>`;
}
