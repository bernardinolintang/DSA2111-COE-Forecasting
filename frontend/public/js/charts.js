// Dependency-free SVG charts.
//
// Conventions (see the dataviz guidelines followed by this project):
//  * 2px lines with round joins, bands as ~10-20% washes of the series colour
//  * hairline, solid, recessive gridlines; one y-axis only
//  * a crosshair that snaps to the nearest x, and ONE tooltip listing every series
//  * columns ≤ 24px wide with 4px rounded data-ends, square at the baseline
//  * text always uses ink tokens, never the series colour
// Every chart re-renders on resize (ResizeObserver) and is keyboard navigable.
//
// Rendering contract: a chart draws synchronously when it is created (so there is
// never a painted frame with an empty SVG), redraws in place through update()
// when its data changes (never destroy + recreate), and redraws on resize only
// when the width actually changed. If the container has no width yet (hidden
// tab, closed <details>), the first ResizeObserver callback draws it.
// update(next, { animate: true }) morphs from the current picture to the new one
// (see "Morphing" below); setPoints() moves highlighted points without a redraw.

import { DURATION, lerp, reducedMotion, tween } from "./motion.js";
import { esc } from "./util.js";

// this is the SVG namespace so that createElementNS makes real SVG elements
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// Scales & ticks
// ---------------------------------------------------------------------------
// this maps data values to pixels so that every axis uses the same maths
function linear(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

// this picks round axis numbers so that the labels read like 100k and not 97,342
export function niceTicks(min, max, count = 5) {
  // this widens a flat range so that a constant series can still be drawn
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

// this picks year or month ticks by the span so that long charts do not get crowded
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

// this turns points into an SVG path so that lines and bands share one builder
const path = (points) => points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

// ---------------------------------------------------------------------------
// Tooltip (DOM, filled with textContent only)
// ---------------------------------------------------------------------------
// this makes the tooltip with textContent only so that data can never inject HTML
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
      // this flips the tooltip to the left near the edge so that it stays inside the chart
      const w = tip.offsetWidth || 180;
      const left = x + 16 + w > bounds ? x - w - 16 : x + 16;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, y)}px`;
      tip.classList.add("show");
    },
    hide() { tip.classList.remove("show"); },
  };
}

// this redraws on resize, once a frame so that a window drag stays smooth
function observe(container, draw) {
  let frame;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => draw()); });
  ro.observe(container);
  return () => { cancelAnimationFrame(frame); ro.disconnect(); };
}

// this writes a message into an empty chart so that a chart with no data is not blank
function emptyState(svg, W, H, text) {
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);
  svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="empty-label">${esc(text)}</text>`;
}

// ---------------------------------------------------------------------------
// Morphing: a chart's state is a "frame" in data units (domains, ticks, series
// points). A change interpolates the frame on screen towards the new one, so a
// new scenario visibly moves the forecast instead of drawing a new graph.
// Series are matched by key; points by x (resampled when the x grids differ,
// e.g. a longer history window or another category's bid grid). Ticks,
// markers and regions that only exist on one side fade in or out.
// ---------------------------------------------------------------------------
// this counts charts so that each one gets its own clip path id
let clipIds = 0;

/** Values of a sorted [[x, ...values]] list at x (linear between points), or null outside it. */
export function sample(pts, x) {
  const n = pts.length;
  if (!n || x < pts[0][0] || x > pts[n - 1][0]) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= x) lo = mid; else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (a[0] === x) return a.slice(1);
  if (b[0] === x) return b.slice(1);
  const k = (x - a[0]) / (b[0] - a[0]);
  return a.slice(1).map((v, i) => v + (b[i + 1] - v) * k);
}

// this merges two sorted lists without repeats so that two x grids can be joined
function mergeSorted(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const v = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
    if (out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/** Points of two series part-way (t) between them; exported for tests. */
export function mixPts(pa, pb, t) {
  if (t >= 1) return pb;
  if (t <= 0) return pa;
  if (pa.length === pb.length && pa.every((p, i) => p[0] === pb[i][0])) {
    return pb.map((p, i) => p.map((v, j) => (j === 0 ? v : lerp(pa[i][j], v, t))));
  }
  // different x grids: this draws the union, a point only one side has keeps its own value so that
  // nothing jumps
  return mergeSorted(pa.map((p) => p[0]), pb.map((p) => p[0])).map((x) => {
    const va = sample(pa, x);
    const vb = sample(pb, x);
    const a = va ?? vb;
    const b = vb ?? va;
    return [x, ...a.map((v, k) => lerp(v, b[k], t))];
  });
}

/** Items in both lists blend; items on one side fade out (A) or in (B). */
// this blends list items by key so that ticks and markers can fade in and out
function fadeUnion(listA, listB, key, t, merge) {
  const byKey = new Map(listA.map((a) => [key(a), a]));
  const seen = new Set();
  const out = listB.map((b) => {
    const k = key(b);
    seen.add(k);
    const a = byKey.get(k);
    return a ? { ...merge(a, b), a: lerp(a.a, b.a, t) } : { ...b, a: b.a * t };
  });
  for (const a of listA) if (!seen.has(key(a))) out.push({ ...a, a: a.a * (1 - t) });
  return out;
}

// this mixes two frames at t so that every part of the chart moves together
function mixFrames(A, B, t) {
  const same = (a, b) => b;
  return {
    x0: lerp(A.x0, B.x0, t), x1: lerp(A.x1, B.x1, t),
    yMin: lerp(A.yMin, B.yMin, t), yMax: lerp(A.yMax, B.yMax, t),
    yTicks: fadeUnion(A.yTicks, B.yTicks, (k) => k.v, t, same),
    series: fadeUnion(A.series, B.series, (s) => s.key, t, (a, b) => ({ ...b, pts: mixPts(a.pts, b.pts, t) })),
    bands: fadeUnion(A.bands, B.bands, (s) => s.key, t, (a, b) => ({ ...b, pts: mixPts(a.pts, b.pts, t) })),
    points: A.points.length === B.points.length
      ? B.points.map((p, i) => ({ ...p, x: lerp(A.points[i].x, p.x, t), y: lerp(A.points[i].y, p.y, t) }))
      : B.points,
    now: A.now != null && B.now != null ? lerp(A.now, B.now, t) : B.now,
    nowLabel: B.nowLabel,
    markers: fadeUnion(A.markers, B.markers, (mk) => `${mk.x}|${mk.label}`, t, same),
    regions: fadeUnion(A.regions, B.regions, (r) => `${r.x0}|${r.x1}`, t, same),
  };
}

// this only writes an opacity when needed so that the SVG stays small
const opacityAttr = (a) => (a < 0.995 ? ` opacity="${Math.max(0, a).toFixed(3)}"` : "");

// ---------------------------------------------------------------------------
// Time / line chart with optional bands, markers and a crosshair
// ---------------------------------------------------------------------------
/**
 * opts:
 *  series:  [{ key, label, color, points: [{x, y}], width?, endDot?, dash? }]   dash: e.g. "7 5" for a forecast
 *  xMarks:  [x]                       small ticks on the baseline (e.g. upcoming bidding exercises)
 *  startZoomed: true to open on the `focus` range instead of everything
 *  bands:   [{ key, color, opacity, points: [{x, lo, hi}] }]
 *  markers: [{ x, label, active? }]   vertical hairlines (e.g. policy events)
 *  regions: [{ x0, x1 }]              shaded x-ranges (e.g. a selected policy period)
 *  points:  [{ x, y, color, r?, guides? }]  highlighted points (guides: lines to both axes)
 *  now:     x                         a "today" divider
 *  xType:   "time" (x = Date) | "linear"
 *  yFormat, xFormat(x) for ticks/tooltip; tooltip(x) -> {title, rows}
 *  height, yZero (include 0), label (aria)
 *  zoom:    true to allow zooming the x-axis (Ctrl/⌘ + wheel or pinch, drag to pan,
 *           double-click or "Reset zoom" to go back); the y-axis fits what is in view
 *  focus:   { x0, x1, label } an x-range offered as a one-click zoom (e.g. the forecast)
 *
 * Returns { update(next, { animate, resetZoom }), setPoints(points), destroy() }.
 */
export function lineChart(container, opts) {
  // this holds the merged options so that update() can swap them
  let o;
  container.classList.add("chart");
  container.replaceChildren();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("tabindex", "0");
  container.appendChild(svg);
  const tip = makeTooltip(container);
  const clipId = `chart-clip-${++clipIds}`;

  // this turns x into a number so that dates and plain numbers share the same code
  const toNum = (x) => (o.xType === "time" ? +x : x);
  // these are the chart's live state so that redraws and hover can share it
  let xsAll = [];
  let lookup = [];
  let geometry = null;
  let active = -1;
  let drawnW = 0;
  let shown = null;            // the frame currently on screen
  let anim = null;             // { from, to, t, handle } while morphing
  let view = null;             // zoomed-in x-range [x0, x1] (data units), or null for everything
  let zoomBar = null;

  // this merges in the defaults and rebuilds the lookups so that hover stays fast
  function configure(next) {
    o = { height: 320, xType: "time", yFormat: String, xFormat: String, series: [], bands: [],
          markers: [], regions: [], points: [], xMarks: [], label: "Chart", emptyText: "No data to show", ...next };
    svg.setAttribute("aria-label", o.label);
    xsAll = [...new Set([
      ...o.series.flatMap((s) => s.points.map((p) => toNum(p.x))),
      ...o.bands.flatMap((b) => b.points.map((p) => toNum(p.x))),
    ])].filter(Number.isFinite).sort((a, b) => a - b);
    lookup = o.series.map((s) => new Map(s.points.map((p) => [toNum(p.x), p.y])));
    if (active >= xsAll.length) active = -1;
  }

  const framePoints = (points) => (points || []).map((p) => ({
    x: toNum(p.x), y: p.y, color: p.color, r: p.r || 6, guides: Boolean(p.guides),
  }));

  /** The target frame for the current options at width W. */
  function targetFrame(W) {
    const compact = W < 520;
    const [vx0, vx1] = view ?? [xsAll[0], xsAll[xsAll.length - 1]];
    const series = o.series.map((s) => ({
      key: s.key, color: s.color, width: s.width || 2, endDot: s.endDot, dash: s.dash || null, a: 1,
      pts: s.points.filter((p) => p.y != null && Number.isFinite(p.y)).map((p) => [toNum(p.x), p.y]),
    }));
    const bands = o.bands.map((b) => ({
      key: b.key, color: b.color, opacity: b.opacity ?? 0.14, a: 1,
      pts: b.points.filter((p) => p.lo != null && p.hi != null).map((p) => [toNum(p.x), p.lo, p.hi]),
    }));
    // the y-axis fits what is in view so that zooming in shows real detail
    const inView = (pts) => {
      if (!view) return pts.flatMap((p) => p.slice(1));
      const vals = pts.filter((p) => p[0] >= vx0 && p[0] <= vx1).flatMap((p) => p.slice(1));
      for (const edge of [sample(pts, vx0), sample(pts, vx1)]) if (edge) vals.push(...edge);
      return vals;
    };
    let yVals = [...series, ...bands].flatMap((s) => inView(s.pts)).filter(Number.isFinite);
    if (!yVals.length) yVals = [...series, ...bands].flatMap((s) => s.pts.flatMap((p) => p.slice(1))).filter(Number.isFinite);
    let yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    if (o.yZero) yMin = Math.min(0, yMin);
    const pad = (yMax - yMin) * 0.06 || 1;
    const nice = o.yDomain                       // fixed domain, e.g. [0, 100] for probabilities
      ? niceTicks(o.yDomain[0], o.yDomain[1], compact ? 4 : 5)
      : niceTicks(o.yZero ? yMin : yMin - pad, yMax + pad, compact ? 4 : 5);
    return {
      x0: vx0, x1: vx1, yMin: nice.min, yMax: nice.max,
      yTicks: nice.ticks.map((v) => ({ v, a: 1 })),
      series,
      bands,
      points: framePoints(o.points),
      now: o.now != null ? toNum(o.now) : null,
      nowLabel: o.nowLabel || "Now",
      markers: o.markers.map((mk) => ({ x: toNum(mk.x), label: mk.label, active: Boolean(mk.active), a: 1 })),
      regions: o.regions.map((r) => ({ x0: toNum(r.x0), x1: toNum(r.x1), a: 1 })),
    };
  }

  // this draws highlighted points with optional guides so that a bid or value can be marked on the
  // chart
  function pointsMarkup(points, { x, y, m, H }) {
    return points.map((p, i) => {
      const px = x(p.x).toFixed(1);
      const py = y(p.y).toFixed(1);
      const guides = p.guides
        ? `<line class="guide" x1="${m.left}" x2="${px}" y1="${py}" y2="${py}"/><line class="guide" x1="${px}" x2="${px}" y1="${py}" y2="${H - m.bottom}"/>`
        : "";
      return `${guides}<circle data-i="${i}" cx="${px}" cy="${py}" r="${p.r}" fill="${p.color}" class="hover-dot"/>`;
    }).join("");
  }

  /** Paint frame F at width W (one innerHTML write). */
  function render(F, W) {
    const H = o.height;
    const compact = W < 520;
    const m = { top: o.markers.length && !compact ? 40 : 12, right: 12, bottom: 28, left: compact ? 46 : 58 };
    const x = linear(F.x0, F.x1, m.left, W - m.right);
    const y = linear(F.yMin, F.yMax, H - m.bottom, m.top);
    geometry = { x, y, m, W, H };

    // this clips the plot area so that zoomed lines do not spill over the axis
    const parts = [`<defs><clipPath id="${clipId}"><rect x="${m.left - 1}" y="0" width="${W - m.left + 1}" height="${H}"/></clipPath></defs>`];
    // this draws gridlines and y labels so that values can be read off
    for (const t of F.yTicks) {
      if (t.a < 0.02) continue;
      const yy = Math.round(y(t.v)) + 0.5;
      if (yy < m.top - 1 || yy > H - m.bottom + 1) continue;
      const op = opacityAttr(t.a);
      parts.push(`<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"${op}/>`);
      parts.push(`<text x="${m.left - 8}" y="${yy + 4}" text-anchor="end"${op}>${esc(o.yFormat(t.v))}</text>`);
    }
    // this draws x labels so that the time axis can be read
    const xTicks = o.xType === "time"
      ? timeTicks(F.x0, F.x1, compact ? 4 : 8)
      : niceTicks(F.x0, F.x1, compact ? 4 : 6).ticks
          .filter((v) => v >= F.x0 && v <= F.x1).map((v) => ({ value: v, label: o.xFormat(v) }));
    for (const t of xTicks) {
      parts.push(`<text x="${x(t.value).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(t.label)}</text>`);
    }
    parts.push(`<line class="baseline" x1="${m.left}" x2="${W - m.right}" y1="${H - m.bottom + 0.5}" y2="${H - m.bottom + 0.5}"/>`);
    // subtle ticks on the baseline, one per forecast bidding exercise so that the exercise dates
    // can be seen
    for (const xv of o.xMarks) {
      const tx = Math.round(x(toNum(xv))) + 0.5;
      if (tx >= m.left && tx <= W - m.right) parts.push(`<line class="x-mark" x1="${tx}" x2="${tx}" y1="${H - m.bottom - 5}" y2="${H - m.bottom}"/>`);
    }

    // this draws regions, bands and the now line inside the clip so that they stay in the plot area
    parts.push(`<g clip-path="url(#${clipId})">`);
    for (const r of F.regions) {
      if (r.a < 0.02) continue;
      const x0 = Math.max(m.left, x(r.x0));
      const x1 = Math.min(W - m.right, x(r.x1));
      if (x1 > x0) parts.push(`<rect class="region" x="${x0.toFixed(1)}" y="${m.top}" width="${(x1 - x0).toFixed(1)}" height="${H - m.top - m.bottom}"${opacityAttr(r.a)}/>`);
    }
    for (const b of F.bands) {
      if (!b.pts.length || b.a < 0.02) continue;
      const upper = b.pts.map((p) => [x(p[0]), y(p[2])]);
      const lower = b.pts.map((p) => [x(p[0]), y(p[1])]).reverse();
      parts.push(`<path d="${path(upper)}${path(lower).replace("M", "L")}Z" fill="${b.color}" fill-opacity="${(b.opacity * b.a).toFixed(3)}"/>`);
    }
    if (F.now != null) {
      const nx = Math.round(x(F.now)) + 0.5;
      parts.push(`<line class="now-line" x1="${nx}" x2="${nx}" y1="${m.top}" y2="${H - m.bottom}"/>`);
      const fits = nx + 6 + String(F.nowLabel).length * 6.2 <= W - 2;
      parts.push(`<text x="${fits ? nx + 6 : nx - 6}" y="${m.top + 11}" class="marker-label"${fits ? "" : ' text-anchor="end"'}>${esc(F.nowLabel)}</text>`);
    }
    // marker labels go in two staggered rows, a label that would still collide is left out and the
    // active marker is labelled first so that the chosen event is never the one dropped
    const rowEnds = [-Infinity, -Infinity];
    const ordered = [...F.markers].sort((a, b) => Number(b.active) - Number(a.active));
    for (const mk of ordered) {
      if (mk.a < 0.02) continue;
      const mx = Math.round(x(mk.x)) + 0.5;
      if (mx < m.left || mx > W - m.right) continue;
      const labelW = String(mk.label).length * 6.2;
      const left = Math.min(Math.max(mx - labelW / 2, m.left), W - m.right - labelW);
      const row = compact && !mk.active ? -1 : rowEnds.findIndex((end) => left > end + 8);
      const cls = mk.active ? " is-active" : "";
      const op = opacityAttr(mk.a);
      parts.push(`<line class="marker-line${cls}" x1="${mx}" x2="${mx}" y1="${row === 1 ? m.top - 18 : m.top - 4}" y2="${H - m.bottom}"${op}/>`);
      if (row >= 0) {
        parts.push(`<text x="${left}" y="${m.top - 8 - row * 14}" class="marker-label${cls}"${op}>${esc(mk.label)}</text>`);
        rowEnds[row] = left + labelW;
      }
    }
    // this draws the lines after the bands so that they sit on top
    for (const s of F.series) {
      if (s.a < 0.02) continue;
      const pts = s.pts.map((p) => [x(p[0]), y(p[1])]);
      const op = opacityAttr(s.a);
      if (pts.length > 1) {
        const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : "";
        parts.push(`<path class="series-line" d="${path(pts)}" stroke="${s.color}" stroke-width="${s.width}"${dash}${op}/>`);
      }
      if (s.endDot && pts.length) {
        const [ex, ey] = pts[pts.length - 1];
        parts.push(`<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4.5" fill="${s.color}" class="hover-dot"${op}/>`);
      }
    }
    parts.push(`<g class="pts">${pointsMarkup(F.points, geometry)}</g>`);
    parts.push("</g>");
    // this adds the hover layer and a hit area so that the pointer works across the whole plot
    parts.push(`<g class="hover" style="display:none"><line class="crosshair" y1="${m.top}" y2="${H - m.bottom}"/>${
      o.series.map((s) => `<circle r="4.5" fill="${s.color}" class="hover-dot"/>`).join("")}</g>`);
    parts.push(`<rect class="hit" x="${m.left}" y="0" width="${W - m.left - m.right}" height="${H}"/>`);

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);
    svg.innerHTML = parts.join("");
    if (active >= 0) highlight(active);
  }

  // this stops a running morph so that a new one can start cleanly
  function stopMorph() {
    anim?.handle.cancel();
    anim = null;
  }

  /** The frame on screen now, including a morph in progress. */
  const currentFrame = () => (anim ? mixFrames(anim.from, anim.to, anim.t) : shown);

  /** Morph from `from` to the target frame (instantly without a `from`, duration or motion). */
  function morphFrom(from, duration) {
    const W = container.clientWidth;
    stopMorph();
    // this draws at once when a morph is not possible so that the chart always ends in the right
    // state
    if (!from || !duration || !W || W !== drawnW || !xsAll.length || reducedMotion()) { draw(true); return; }
    const state = { from, to: targetFrame(W), t: 0 };
    anim = state;
    state.handle = tween({
      duration,
      onUpdate: (t) => { state.t = t; shown = mixFrames(state.from, state.to, t); render(shown, W); },
      onDone: () => { if (anim === state) anim = null; shown = state.to; render(shown, W); },
    });
  }

  // this draws for the current width, only when it changed so that a resize with no change costs
  // nothing
  function draw(force = false) {
    const W = container.clientWidth;
    if (!W || (!force && W === drawnW)) return;
    const resized = W !== drawnW;
    drawnW = W;
    if (!xsAll.length) { stopMorph(); shown = null; geometry = null; emptyState(svg, W, o.height, o.emptyText); return; }
    if (anim && !resized) return;               // the running morph paints every frame
    stopMorph();                                // a resize mid-morph jumps to the end state
    shown = targetFrame(W);
    render(shown, W);
  }

  // this moves the crosshair and tooltip to one x so that one hover shows every series
  function highlight(i) {
    if (!geometry || i < 0) return;
    active = i;
    const xv = xsAll[i];
    const { x, y } = geometry;
    const g = svg.querySelector(".hover");
    if (!g) return;
    g.style.display = "";
    const cx = Math.round(x(xv)) + 0.5;
    const line = g.querySelector("line");
    line.setAttribute("x1", cx);
    line.setAttribute("x2", cx);
    g.querySelectorAll("circle").forEach((c, k) => {
      const v = lookup[k]?.get(xv);
      c.style.display = v == null ? "none" : "";
      if (v != null) { c.setAttribute("cx", x(xv)); c.setAttribute("cy", y(v)); }
    });
    const content = o.tooltip ? o.tooltip(o.xType === "time" ? new Date(xv) : xv, i) : null;
    if (content) tip.show(content, x(xv), geometry.m.top, geometry.W);
  }

  // this hides the hover layer so that it clears when the pointer leaves
  function clear() {
    active = -1;
    const g = svg.querySelector(".hover");
    if (g) g.style.display = "none";
    tip.hide();
  }

  // this finds the closest x with a binary search so that hover stays fast on long series
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

  // this converts a pointer event into a chart index so that mouse and touch share one path
  const pointAt = (e) => {
    if (!geometry || !xsAll.length) return;
    const rect = svg.getBoundingClientRect();
    highlight(nearest((e.clientX - rect.left) * (geometry.W / rect.width)));
  };
  svg.addEventListener("pointermove", pointAt);
  // touch: a tap shows the values and they stay until you tap elsewhere so that it works with no
  // hover on phones
  svg.addEventListener("pointerdown", pointAt);
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") clear(); });
  svg.addEventListener("blur", clear);
  // this adds keyboard control so that the chart works without a mouse
  svg.addEventListener("keydown", (e) => {
    if (!geometry || !xsAll.length) return;
    if (zoomBar && ["+", "=", "-", "_", "0"].includes(e.key) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (e.key === "0") { zoomTo(null, DURATION.route); return; }
      const [a, b] = view ?? extent();
      const anchor = active >= 0 ? xsAll[active] : (a + b) / 2;
      const k = e.key === "-" || e.key === "_" ? 1.5 : 1 / 1.5;
      zoomTo(clampView(anchor - (anchor - a) * k, anchor + (b - anchor) * k), DURATION.tab);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const start = active < 0 ? xsAll.length - 1 : active;
    const i = Math.min(xsAll.length - 1, Math.max(0, start + (e.key === "ArrowRight" ? 1 : -1)));
    highlight(i);
    const xv = xsAll[i];
    if (view && (xv < view[0] || xv > view[1])) {            // keep the highlighted point in view
      const span = view[1] - view[0];
      zoomTo(clampView(xv - span / 2, xv + span / 2), DURATION.micro);
    }
  });

  // ---- zoom (opt-in) --------------------------------------------------------
  // Ctrl/Cmd + wheel, or a trackpad pinch (which browsers send as Ctrl + wheel), zooms around the
  // pointer while plain scrolling still scrolls the page. each step eases to the new range so that
  // it feels smooth
  const extent = () => [xsAll[0], xsAll[xsAll.length - 1]];

  /** A valid zoom range: at least ~5 data steps wide, inside the data; null means everything. */
  function clampView(a, b) {
    if (a == null || !xsAll.length) return null;
    const [f0, f1] = extent();
    const minSpan = Math.min(f1 - f0, ((f1 - f0) / Math.max(1, xsAll.length - 1)) * 5);
    const span = Math.max(minSpan, b - a);
    if (span >= (f1 - f0) * 0.995) return null;
    const lo = Math.min(Math.max(a, f0), f1 - span);
    return [lo, lo + span];
  }

  // this updates the zoom buttons so that they match the current range
  function paintZoom() {
    container.classList.toggle("is-zoomed", Boolean(view));
    if (!zoomBar) return;
    zoomBar.querySelector('[data-zoom="reset"]').disabled = !view;
    const focus = zoomBar.querySelector('[data-zoom="focus"]');
    focus.hidden = !o.focus;
    if (o.focus) focus.textContent = o.focus.label || "Zoom in";
  }

  // this animates to a new x range so that zooming is easy to follow
  function zoomTo(next, duration) {
    if (!next && !view) return;
    const from = currentFrame();
    view = next;
    paintZoom();
    morphFrom(from, duration);
  }

  // this zooms on Ctrl + wheel so that normal scrolling is left alone
  svg.addEventListener("wheel", (e) => {
    if (!zoomBar || !(e.ctrlKey || e.metaKey) || !geometry || !xsAll.length) return;
    e.preventDefault();                                          // zoom the chart, not the page
    const { m, W } = geometry;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    const f = Math.min(1, Math.max(0, (px - m.left) / (W - m.left - m.right)));
    const [a, b] = view ?? extent();
    const k = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))));
    const anchor = a + (b - a) * f;                              // the date under the pointer stays put
    zoomTo(clampView(anchor - (anchor - a) * k, anchor + (b - anchor) * k), DURATION.micro);
  }, { passive: false });

  // drag to pan while zoomed, mouse only so that on touch a drag keeps scrolling the page
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (!view || e.pointerType !== "mouse" || e.button !== 0 || !geometry) return;
    drag = { x: e.clientX, view };
    svg.setPointerCapture(e.pointerId);
    container.classList.add("is-panning");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const { m, W } = geometry;
    const plot = svg.getBoundingClientRect().width * ((W - m.left - m.right) / W);
    const dx = ((e.clientX - drag.x) / plot) * (drag.view[1] - drag.view[0]);
    stopMorph();
    view = clampView(drag.view[0] - dx, drag.view[1] - dx);    // follows the pointer directly
    draw(true);
  });
  const endDrag = () => { drag = null; container.classList.remove("is-panning"); };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  // this resets the zoom on double click so that the full chart is one gesture away
  svg.addEventListener("dblclick", () => zoomTo(null, DURATION.route));

  configure(opts);
  // this adds the zoom buttons only when asked so that small charts stay clean
  if (o.zoom) {
    const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
    zoomBar = document.createElement("div");
    zoomBar.className = "chart-zoombar";
    zoomBar.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" data-zoom="focus" hidden></button>
      <button type="button" class="btn btn-ghost btn-sm" data-zoom="reset" disabled>Reset zoom</button>
      <span class="caption zoom-hint">Zoom: hold ${mod} and scroll (or pinch) over the chart · drag to pan · double-click to reset</span>`;
    container.appendChild(zoomBar);
    zoomBar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-zoom]");
      if (!b) return;
      if (b.dataset.zoom === "reset") zoomTo(null, DURATION.route);
      else if (o.focus) zoomTo(clampView(toNum(o.focus.x0), toNum(o.focus.x1)), DURATION.route);
    });
    if (o.focus && o.startZoomed) view = clampView(toNum(o.focus.x0), toNum(o.focus.x1));
    paintZoom();
  }
  draw(true);                                 // synchronous first paint
  // this starts drawing on resize and returns the controls so that pages can update the chart in
  // place
  const stop = observe(container, draw);
  return {
    /**
     * Redraw in place with new options (same SVG, observer and tooltip).
     * animate: morph from what is on screen now (interruptible: a change made
     * mid-morph continues from the current in-between state).
     */
    update(next, { animate = false, duration = DURATION.card, resetZoom = false } = {}) {
      const from = animate ? currentFrame() : null;
      stopMorph();
      configure({ ...o, ...next });
      view = resetZoom || !view ? null : clampView(view[0], view[1]);   // a zoom survives new data
      paintZoom();
      morphFrom(from, animate ? duration : 0);
    },
    /** Move the highlighted points only; the rest of the chart is untouched. */
    setPoints(points) {
      o.points = points;
      if (anim) { anim.to = { ...anim.to, points: framePoints(points) }; return; }
      if (!shown || !geometry) { draw(true); return; }
      shown = { ...shown, points: framePoints(points) };
      const g = svg.querySelector(".pts");
      if (g) g.innerHTML = pointsMarkup(shown.points, geometry);
      else render(shown, drawnW);
    },
    destroy() { stopMorph(); stop(); },
  };
}

// ---------------------------------------------------------------------------
// Column chart (one series) with per-bar tooltips
// ---------------------------------------------------------------------------
/** items: [{ label, value, color?, title? }]. Returns { update(items, { animate }), destroy() }. */
export function columnChart(container, { items, height = 220, yFormat = String, color = "var(--accent)",
                                         label = "Column chart", tickEvery = 1 }) {
  container.classList.add("chart");
  container.replaceChildren();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  container.appendChild(svg);
  const tip = makeTooltip(container);
  let drawnW = 0;
  let shown = null;      // { yMax, ticks: [{v, a}], values: [] }
  let anim = null;

  // this builds one frame for the bars so that they can be morphed like the line chart
  function frameFor(list) {
    const nice = niceTicks(0, Math.max(...list.map((d) => d.value)), 4);
    return { yMax: nice.max, ticks: nice.ticks.map((v) => ({ v, a: 1 })), values: list.map((d) => d.value) };
  }

  // this draws the columns so that each bar has its own hover and focus target
  function render(F, W) {
    const m = { top: 12, right: 8, bottom: 26, left: 48 };
    const y = linear(0, F.yMax, height - m.bottom, m.top);
    const band = (W - m.left - m.right) / items.length;
    const barW = Math.min(24, Math.max(2, band - 2));             // 2px surface gap between bars
    const parts = [];
    for (const t of F.ticks) {
      if (t.a < 0.02) continue;
      const yy = Math.round(y(t.v)) + 0.5;
      if (yy < m.top - 1) continue;
      const op = opacityAttr(t.a);
      parts.push(`<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"${op}/>`);
      parts.push(`<text x="${m.left - 8}" y="${yy + 4}" text-anchor="end"${op}>${esc(yFormat(t.v))}</text>`);
    }
    items.forEach((d, i) => {
      const cx = m.left + band * i + band / 2;
      const top = Math.max(m.top, y(F.values[i]));
      const h = Math.max(0, height - m.bottom - top);
      const r = Math.min(4, barW / 2, h);
      const x0 = cx - barW / 2;
      const base = height - m.bottom;
      // rounded data-end, square at the baseline so that bars follow the chart style
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

  // this draws for the current width so that the bars fit the card
  function draw(force = false) {
    const W = container.clientWidth;
    if (!W || (!force && W === drawnW)) return;
    const resized = W !== drawnW;
    drawnW = W;
    if (!items.length) { anim?.cancel(); anim = null; shown = null; emptyState(svg, W, height, "No data to show"); return; }
    if (anim && !resized) return;
    anim?.cancel();
    anim = null;
    shown = frameFor(items);
    render(shown, W);
  }

  // this shows the tooltip for one bar so that mouse and keyboard use the same code
  function show(i) {
    const d = items[i];
    if (!d) return;
    const band = +svg.dataset.band;
    const cx = +svg.dataset.left + band * i + band / 2;
    tip.show({ title: d.title || d.label, rows: [{ value: yFormat(d.value), label: d.seriesLabel || "", color: d.color || color }] },
      cx, 8, +svg.dataset.width);
  }
  // this finds the bar under the pointer so that the tooltip follows it
  svg.addEventListener("pointermove", (e) => {
    const i = e.target.closest("[data-i]")?.dataset.i;
    if (i == null) tip.hide(); else show(+i);
  });
  svg.addEventListener("pointerleave", () => tip.hide());
  svg.addEventListener("focusin", (e) => { const i = e.target.dataset.i; if (i != null) show(+i); });
  svg.addEventListener("focusout", () => tip.hide());

  draw(true);                                 // synchronous first paint
  const stop = observe(container, draw);
  return {
    /** New data in place; with animate, bars grow/shrink from their current heights. */
    update(next, { animate = false } = {}) {
      const W = container.clientWidth;
      const from = shown;
      const canMorph = animate && W && W === drawnW && from && next.length && next.length === from.values.length && !reducedMotion();
      anim?.cancel();
      anim = null;
      items = next;
      if (!canMorph) { draw(true); return; }
      const to = frameFor(items);
      const handle = tween({
        onUpdate: (t) => {
          shown = {
            yMax: lerp(from.yMax, to.yMax, t),
            ticks: fadeUnion(from.ticks, to.ticks, (k) => k.v, t, (a, b) => b),
            values: to.values.map((v, i) => lerp(from.values[i], v, t)),
          };
          render(shown, W);
        },
        onDone: () => { if (anim === handle) anim = null; shown = to; render(to, W); },
      });
      anim = handle;
    },
    destroy() { anim?.cancel(); stop(); },
  };
}

// ---------------------------------------------------------------------------
// Sparkline: history in the accent, forecast median as a faded continuation
// ---------------------------------------------------------------------------
// this draws a small inline chart as a string so that cards can embed it directly
export function sparkline(values, forecast = [], { width = 220, height = 44 } = {}) {
  const all = [...values, ...forecast];
  if (all.length < 2) return "";
  const min = Math.min(...all);
  const max = Math.max(...all);
  const x = linear(0, all.length - 1, 2, width - 6);
  const y = linear(min, max === min ? min + 1 : max, height - 4, 4);
  // this splits history and forecast so that the future part can be drawn fainter
  const hist = values.map((v, i) => [x(i), y(v)]);
  const fut = [hist[hist.length - 1], ...forecast.map((v, i) => [x(values.length + i), y(v)])];
  const [ex, ey] = hist[hist.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${path(hist)}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${forecast.length ? `<path d="${path(fut)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` : ""}
    <circle cx="${ex}" cy="${ey}" r="3.5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Horizontal bar list (HTML): label · bar · value, sorted by the caller
// ---------------------------------------------------------------------------
/** rows: [{ label, value, display, color?, highlight? }] */
// this scales each bar to the largest value so that rows can be compared at a glance
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
// this builds a plain table so that the chart data is readable without the chart
export function dataTable(columns, rows) {
  return `<div class="table-wrap"><table class="data"><thead><tr>${
    columns.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? "num" : ""}">${esc(c.get(r))}</td>`).join("")}</tr>`).join("")
  }</tbody></table></div>`;
}
