// Draws every figure of the project report as SVG and rasterises it with Chrome.
//
//   NODE_PATH=<frontend/node_modules> node report/src/figures.cjs
//
// Inputs : report/data/*.json  (a snapshot of the API responses of one model run)
//          report/figures/ui_*.png (screenshots from shots.cjs)
// Outputs: report/figures/fig_*.png at 4x device scale (about 380 dpi in print)
//
// Sizes are CSS pixels at 96 dpi: 332 px is one IEEE column (88 mm), 685 px is
// the full text width (181 mm), so 10.5 px text prints at about 8 pt.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const OUT = path.join(ROOT, "figures");
const load = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));

const COL = 332, FULL = 685;
const FONT = `"Times New Roman", Times, serif`;
const INK = "#0b0b0b", INK2 = "#45443f", GRID = "#e4e3dd", AXIS = "#8f8d86", BAND = "#f1f0eb";
// Categorical slots in fixed order (validated on a white surface with validate_palette.js).
const C = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", yellow: "#eda100", magenta: "#e87ba4" };

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (v) => Number(v.toFixed(2));

function text(x, y, str, o = {}) {
  const { anchor = "start", size = 10.5, fill = INK, weight = 400, italic = false, rotate } = o;
  const tf = rotate ? ` transform="rotate(${rotate} ${n(x)} ${n(y)})"` : "";
  return `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" font-size="${size}" fill="${fill}" ` +
    `font-weight="${weight}"${italic ? ' font-style="italic"' : ""}${tf}>${esc(str)}</text>`;
}
/** Italic context-vector labels such as c_s: [["c", "s"], [", c", "c"]] -> c with subscript s, ... */
function subText(x, y, parts, size = 9.5) {
  const spans = parts.map(([base, sub]) =>
    `<tspan>${esc(base)}</tspan><tspan dy="2.6" font-size="${size * 0.72}">${esc(sub)}</tspan><tspan dy="-2.6" font-size="1"> </tspan>`).join("");
  return `<text x="${n(x)}" y="${n(y)}" text-anchor="middle" font-size="${size}" fill="${INK2}" font-style="italic">${spans}</text>`;
}
const line = (x1, y1, x2, y2, stroke = AXIS, w = 1, extra = "") =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${w}" ${extra}/>`;
const rect = (x, y, w, h, fill, extra = "") =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}" ${extra}/>`;
const polyline = (pts, stroke, w = 2, extra = "") =>
  `<path d="M${pts.map(([x, y]) => `${n(x)},${n(y)}`).join("L")}" fill="none" stroke="${stroke}" ` +
  `stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;
const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
  `font-family='${FONT}'>` +
  `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" ` +
  `orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="${INK2}"/></marker></defs>` +
  rect(0, 0, w, h, "#ffffff") + body + `</svg>`;

/** Marker shapes give a second, colour-independent encoding for greyscale print. */
function marker(shape, x, y, fill, r = 3.4) {
  const ring = `stroke="#ffffff" stroke-width="1.5"`;
  if (shape === "square") return rect(x - r, y - r, 2 * r, 2 * r, fill, ring);
  if (shape === "triangle")
    return `<path d="M${n(x)},${n(y - r - 0.8)} L${n(x + r + 0.6)},${n(y + r)} L${n(x - r - 0.6)},${n(y + r)} z" fill="${fill}" ${ring}/>`;
  if (shape === "diamond")
    return `<path d="M${n(x)},${n(y - r - 1)} L${n(x + r + 1)},${n(y)} L${n(x)},${n(y + r + 1)} L${n(x - r - 1)},${n(y)} z" fill="${fill}" ${ring}/>`;
  return `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${fill}" ${ring}/>`;
}

/** A labelled box for the diagrams: bold title plus optional detail lines. */
function box(x, y, w, h, title, lines = [], o = {}) {
  const { fill = "#ffffff", stroke = INK2, titleSize = 10.5, lineSize = 9, align = "middle", italicLast = false } = o;
  const tx = align === "middle" ? x + w / 2 : x + 7;
  const total = titleSize + lines.length * (lineSize + 2.5);
  let ty = y + (h - total) / 2 + titleSize - 1.5;
  let out = rect(x, y, w, h, fill, `rx="4" stroke="${stroke}" stroke-width="0.9"`);
  out += text(tx, ty, title, { anchor: align, size: titleSize, weight: 700 });
  lines.forEach((l, i) => {
    ty += lineSize + 2.5;
    out += text(tx, ty, l, { anchor: align, size: lineSize, fill: INK2, italic: italicLast && i === lines.length - 1 });
  });
  return out;
}
const arrow = (pts, extra = "") =>
  `<path d="M${pts.map(([x, y]) => `${n(x)},${n(y)}`).join("L")}" fill="none" stroke="${INK2}" stroke-width="1" ` +
  `marker-end="url(#arrow)" ${extra}/>`;

// ---------------------------------------------------------------------------
// Fig. 1 - premium history with policy events
// ---------------------------------------------------------------------------
function figHistory() {
  const W = FULL, H = 262, m = { l: 40, r: 10, t: 34, b: 24 };
  const cats = [["A", C.blue], ["B", C.orange], ["C", C.aqua], ["D", C.yellow], ["E", C.magenta]];
  const when = (p) => { const d = new Date(p.month); return d.getUTCFullYear() + d.getUTCMonth() / 12 + (p.bidding_no - 1) / 24; };
  const x = scale(2010, 2027, m.l, W - m.r), y = scale(0, 160000, H - m.b, m.t);
  let s = "";

  // held-out test period (last 72 exercises)
  const histA = load("hist_A.json").points;
  const testStart = when(histA[histA.length - 72]);
  s += rect(x(testStart), m.t, x(when(histA[histA.length - 1])) - x(testStart) + 3, H - m.b - m.t, BAND);
  s += text(x(testStart) + 5, y(30000), "Held-out test period", { size: 9.5, fill: INK2, italic: true });
  s += text(x(testStart) + 5, y(30000) + 11, "(last 72 exercises)", { size: 9.5, fill: INK2, italic: true });

  for (const v of [0, 40000, 80000, 120000, 160000]) {
    s += line(m.l, y(v), W - m.r, y(v), v === 0 ? AXIS : GRID);
    s += text(m.l - 5, y(v) + 3.5, v === 0 ? "0" : `${v / 1000}k`, { anchor: "end", size: 10, fill: INK2 });
  }
  for (let yr = 2010; yr <= 2026; yr += 2) {
    s += line(x(yr), H - m.b, x(yr), H - m.b + 3.5, AXIS);
    s += text(x(yr), H - m.b + 15, String(yr), { anchor: "middle", size: 10, fill: INK2 });
  }
  s += text(m.l - 34, m.t - 20, "COE premium (S$)", { size: 10, fill: INK2 });

  // policy events: hairline plus a numbered tag keyed to Table III
  const events = load("policy_events.json");
  const starts = { mas_loan_curbs_2013: 2013 + 2 / 12, cat_a_power_cap_2014: 2014 + 1 / 12, mas_loan_easing_2016: 2016 + 5 / 12,
    zero_growth_2018: 2018 + 1 / 12, covid_resumption_2020: 2020 + 6 / 12, ev_reclassification_2022: 2022 + 4 / 12,
    cut_and_fill_2023: 2023 + 4 / 12, quota_injection_2025: 2025 + 1 / 12 };
  events.forEach((e, i) => {
    const px = x(starts[e.code]);
    s += line(px, m.t - 4, px, H - m.b, AXIS, 0.9);
    s += `<circle cx="${n(px)}" cy="${m.t - 11}" r="7" fill="#ffffff" stroke="${INK2}" stroke-width="0.9"/>`;
    s += text(px, m.t - 7.6, `P${i + 1}`, { anchor: "middle", size: 8, weight: 700 });
  });

  for (const [cat, colour] of cats) {
    const pts = load(`hist_${cat}.json`).points.map((p) => [x(when(p)), y(p.premium)]);
    s += polyline(pts, colour, 1.5);
  }
  // legend (five series, so identity is carried by the legend rather than end labels)
  let lx = m.l + 10;
  s += rect(lx - 5, m.t + 2, 5 * 58 + 2, 17, "#ffffff", `fill-opacity="0.92"`);
  for (const [cat, colour] of cats) {
    s += line(lx, m.t + 10, lx + 16, m.t + 10, colour, 2.2);
    s += text(lx + 20, m.t + 13.5, `Cat ${cat}`, { size: 10 });
    lx += 58;
  }
  return { name: "fig_history", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
// Fig. 2 - deployment architecture
// ---------------------------------------------------------------------------
function figArchitecture() {
  const W = FULL, H = 252;
  const tint = "#f3f6fb", data = "#f6f5f0";
  let s = "";
  // cluster boundary
  s += rect(150, 8, 372, 236, "#fbfbf9", `rx="6" stroke="${AXIS}" stroke-width="0.9"`);
  s += text(160, 23, "Docker Compose (laptop)  /  MicroK8s namespace coe-g7 (Ronin cloud VM)", { size: 9.5, fill: INK2, italic: true });

  s += box(8, 44, 108, 62, "User browser", ["single-page app", "(ES modules, SVG charts)"], { fill: "#ffffff" });
  s += box(8, 146, 108, 78, "Open data APIs", ["data.gov.sg: LTA", "COE bidding results", "SingStat: CPI, SORA, GDP"], { fill: data });

  s += box(166, 36, 150, 78, "web", ["nginx:alpine (94 MB)", "static SPA + reverse proxy", "Deployment ×2, NodePort 30080"], { fill: tint, italicLast: true });
  s += box(360, 36, 150, 78, "api", ["FastAPI + Uvicorn, 2 workers", "REST, OpenAPI, COE Analyst", "Deployment ×2, HPA 2–5 pods"], { fill: tint, italicLast: true });
  s += box(166, 146, 150, 78, "ml (batch)", ["Python + PyTorch (CPU)", "Box-Tiao, TFT, backtest", "Job + weekly CronJob"], { fill: tint, italicLast: true });
  s += box(360, 146, 150, 78, "db", ["PostgreSQL 16", "11 tables, schema as code", "Deployment ×1 + 1 Gi PVC"], { fill: data, italicLast: true });

  s += box(566, 36, 112, 78, "LLM provider", ["Groq or Claude API", "tool calling, streamed", "optional; else basic mode"], { fill: "#ffffff", italicLast: true });
  s += box(566, 146, 112, 78, "Operations", ["Bash: deploy, retrain,", "backup, status", "kustomize, registry :32000"], { fill: "#ffffff" });

  s += arrow([[116, 75], [165, 75]]);
  s += text(140.5, 69, "HTTP", { anchor: "middle", size: 9, fill: INK2 });
  s += arrow([[316, 75], [359, 75]]);
  s += text(337.5, 69, "/api/*", { anchor: "middle", size: 9, fill: INK2 });
  s += arrow([[510, 75], [565, 75]]);
  s += text(538, 69, "HTTPS", { anchor: "middle", size: 9, fill: INK2 });
  s += arrow([[435, 114], [435, 145]]);
  s += text(441, 127, "SQL read;", { size: 9, fill: INK2 });
  s += text(441, 138, "watchlist write", { size: 9, fill: INK2 });
  s += arrow([[316, 185], [359, 185]]);
  s += text(337.5, 179, "write", { anchor: "middle", size: 9, fill: INK2 });
  s += arrow([[165, 185], [117, 185]]);
  s += text(141, 179, "REST", { anchor: "middle", size: 9, fill: INK2 });
  s += arrow([[565, 185], [523, 185]]);
  s += text(544, 179, "apply", { anchor: "middle", size: 9, fill: INK2 });
  return { name: "fig_architecture", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
// Fig. 3 - ML pipeline
// ---------------------------------------------------------------------------
function figPipeline() {
  const W = COL, bh = 29, gap = 7, bw = 316, x0 = 8;
  const steps = [
    ["1. Ingest", "data.gov.sg (LTA) + SingStat; CSV snapshot fallback"],
    ["2. Panel construction", "396 exercises × 5 categories; macro lagged by publication delay"],
    ["3. Transforms and features", "Box-Cox + Min-Max target; 17 known-future, 7 observed inputs"],
    ["4. Box-Tiao intervention analysis", "per category, ARIMA(p,1,q) errors by AIC, parallel processes"],
    ["5. Windowing", "24 past exercises → 6 future exercises"],
    ["6. Rolling-origin backtest", "CV epoch selection (3 folds × 3 seeds); 8 models; DM tests"],
    ["7. Production training", "TFT 3-seed ensemble + Box-Tiao ARIMAX on all data"],
    ["8. Hybrid forecast", "quantile averaging; 5 supply scenarios; p5 … p95"],
    ["9. Persist", "one model_runs row + child tables in PostgreSQL"],
  ];
  const H = steps.length * bh + (steps.length - 1) * gap + 8;
  let s = "", y = 4;
  steps.forEach(([title, detail], i) => {
    const fill = i === 8 ? "#f6f5f0" : i >= 5 ? "#f3f6fb" : "#ffffff";
    s += box(x0, y, bw, bh, title, [detail], { fill, titleSize: 10, lineSize: 9 });
    if (i < steps.length - 1) s += arrow([[x0 + bw / 2, y + bh], [x0 + bw / 2, y + bh + gap - 1]]);
    y += bh + gap;
  });
  return { name: "fig_pipeline", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
// Fig. 4 - TFT architecture as implemented
// ---------------------------------------------------------------------------
function figTft() {
  const W = COL, H = 348;
  const mx = 104, mw = 222;           // main column
  const px = 104, pw = 106, fx = 220, fw = 106;   // past / future halves
  const tint = "#f3f6fb", data = "#f6f5f0";
  const cx = mx + mw / 2;
  let s = "";
  const row = (y, h, title, lines = []) => box(mx, y, mw, h, title, lines, { fill: tint, titleSize: 10, lineSize: 9 });

  s += text(cx, 11, "p5, p10, p25, p50, p75, p90, p95 for each of 6 exercises", { anchor: "middle", size: 9.5, fill: INK2, italic: true });
  s += arrow([[cx, 30], [cx, 16]]);
  s += row(30, 32, "Monotone quantile head", ["anchor + step scale × z, no quantile crossing"]);
  s += arrow([[cx, 76], [cx, 63]]);
  s += row(76, 24, "Position-wise GRN + gated skip");
  s += arrow([[cx, 114], [cx, 101]]);
  s += row(114, 32, "Interpretable multi-head attention", ["4 heads, shared values, causal mask"]);
  s += arrow([[cx, 160], [cx, 147]]);
  s += row(160, 24, "Static enrichment (GRN)");
  s += arrow([[cx, 198], [cx, 185]]);
  s += row(198, 24, "Gate + Add & Norm (skip from selection)");

  s += box(px, 238, pw, 24, "LSTM encoder", [], { fill: tint, titleSize: 10 });
  s += box(fx, 238, fw, 24, "LSTM decoder", [], { fill: tint, titleSize: 10 });
  s += arrow([[px + pw, 250], [fx - 1, 250]]);
  s += arrow([[px + pw / 2, 238], [px + pw / 2, 223]]);
  s += arrow([[fx + fw / 2, 238], [fx + fw / 2, 223]]);

  s += box(px, 276, pw, 24, "Variable selection", [], { fill: tint, titleSize: 10 });
  s += box(fx, 276, fw, 24, "Variable selection", [], { fill: tint, titleSize: 10 });
  s += arrow([[px + pw / 2, 276], [px + pw / 2, 263]]);
  s += arrow([[fx + fw / 2, 276], [fx + fw / 2, 263]]);

  s += box(px, 314, pw, 30, "Past inputs", ["24 steps × 24 variables"], { fill: data, titleSize: 10, lineSize: 9 });
  s += box(fx, 314, fw, 30, "Known future", ["6 steps × 17 variables"], { fill: data, titleSize: 10, lineSize: 9 });
  s += arrow([[px + pw / 2, 314], [px + pw / 2, 301]]);
  s += arrow([[fx + fw / 2, 314], [fx + fw / 2, 301]]);

  // static branch
  s += box(6, 314, 74, 30, "Static", ["category"], { fill: data, titleSize: 10, lineSize: 9 });
  s += box(6, 264, 74, 38, "Static", ["encoders", "(4 GRNs)"], { fill: tint, titleSize: 10, lineSize: 9 });
  s += arrow([[43, 314], [43, 303]]);
  s += arrow([[80, 288], [px - 1, 288]]);
  s += subText(92, 283, [["c", "s"]]);
  s += `<path d="M43,264 L43,172" fill="none" stroke="${INK2}" stroke-width="1"/>`;
  s += arrow([[43, 250], [px - 1, 250]]);
  s += subText(73, 245, [["c", "h"], [", c", "c"]]);
  s += arrow([[43, 172], [mx - 1, 172]]);
  s += subText(73, 167, [["c", "e"]]);
  return { name: "fig_tft", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
// Fig. 5 - user interface (two screenshots side by side)
// ---------------------------------------------------------------------------
function figUi() {
  const W = FULL, iw = 338, ih = Math.round(iw * 700 / 900), gap = W - 2 * iw, H = ih + 18;
  const uri = (f) => "data:image/png;base64," + fs.readFileSync(path.join(OUT, f)).toString("base64");
  let s = "";
  [["ui_forecast.png", "(a)"], ["ui_bid.png", "(b)"]].forEach(([file, label], i) => {
    const x = i * (iw + gap);
    s += `<image href="${uri(file)}" x="${x}" y="0" width="${iw}" height="${ih}" preserveAspectRatio="xMidYMin slice"/>`;
    s += rect(x + 0.5, 0.5, iw - 1, ih - 1, "none", `stroke="${AXIS}" stroke-width="0.8"`);
    s += text(x + iw / 2, ih + 13, label, { anchor: "middle", size: 10 });
  });
  return { name: "fig_ui", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
// Fig. 6 - cross-validated learning curves
// ---------------------------------------------------------------------------
function figCv() {
  const W = COL, H = 208, m = { l: 40, r: 76, t: 22, b: 32 };
  const curves = load("model_metrics.json").run.metrics.cv_curves;
  const series = [["tft", "TFT", C.blue, "circle"], ["tft_no_policy", "TFT, no policy", C.orange, "square"], ["lstm", "LSTM", C.aqua, "triangle"]];
  const x = scale(1, 15, m.l + 4, W - m.r), y = scale(1.2, 1.7, H - m.b, m.t);
  let s = "";
  for (const v of [1.2, 1.3, 1.4, 1.5, 1.6, 1.7]) {
    s += line(m.l, y(v), W - m.r + 4, y(v), GRID);
    s += text(m.l - 5, y(v) + 3.5, v.toFixed(1), { anchor: "end", size: 10, fill: INK2 });
  }
  s += line(m.l, H - m.b, W - m.r + 4, H - m.b, AXIS);
  for (let e = 1; e <= 15; e += 2) {
    s += line(x(e), H - m.b, x(e), H - m.b + 3.5, AXIS);
    s += text(x(e), H - m.b + 14, String(e), { anchor: "middle", size: 10, fill: INK2 });
  }
  s += text((m.l + W - m.r) / 2, H - 3, "Training epochs", { anchor: "middle", size: 10, fill: INK2 });
  s += text(m.l - 34, m.t - 10, "Validation pinball loss (×10⁻², scaled target)", { size: 10, fill: INK2 });
  for (const [key, label, colour, shape] of series) {
    const vals = curves[key].map((v) => v * 100);
    s += polyline(vals.map((v, i) => [x(i + 1), y(v)]), colour, 1.8);
    const best = vals.indexOf(Math.min(...vals));
    s += marker(shape, x(best + 1), y(vals[best]), colour, 3.8);
    s += marker(shape, W - m.r + 9, y(vals[14]), colour, 3);
    s += text(W - m.r + 16, y(vals[14]) + 3.5, label, { size: 10 });
  }
  return { name: "fig_cv", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
// Fig. 7 - pinball skill against the random walk, by horizon
// ---------------------------------------------------------------------------
function figSkill() {
  const W = COL, H = 214, m = { l: 34, r: 104, t: 22, b: 32 };
  const rows = load("model_metrics.json").by_horizon;
  const pin = (model, h) => rows.find((r) => r.model === model && r.horizon === h).pinball;
  const skill = (model) => [1, 2, 3, 4, 5, 6].map((h) => (1 - pin(model, h) / pin("naive", h)) * 100);
  const series = [["hybrid", "Hybrid (ours)", C.blue, "circle", 2.2], ["arimax_boxtiao", "ARIMAX + Box-Tiao", C.orange, "square", 1.6],
    ["lstm", "Seq2Seq LSTM", C.aqua, "triangle", 1.6], ["tft", "TFT alone", C.yellow, "diamond", 1.6]];
  const x = scale(1, 6, m.l + 8, W - m.r), y = scale(-6, 2, H - m.b, m.t);
  let s = "";
  for (const v of [-6, -4, -2, 0, 2]) {
    s += line(m.l, y(v), W - m.r + 4, y(v), v === 0 ? INK2 : GRID, v === 0 ? 1 : 1);
    s += text(m.l - 5, y(v) + 3.5, `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}`, { anchor: "end", size: 10, fill: INK2 });
  }
  for (let h = 1; h <= 6; h++) {
    s += line(x(h), H - m.b, x(h), H - m.b + 3.5, AXIS);
    s += text(x(h), H - m.b + 14, String(h), { anchor: "middle", size: 10, fill: INK2 });
  }
  s += line(m.l, H - m.b, W - m.r + 4, H - m.b, AXIS);
  s += text((m.l + W - m.r) / 2, H - 3, "Forecast horizon (exercises ahead)", { anchor: "middle", size: 10, fill: INK2 });
  s += text(m.l - 28, m.t - 10, "Pinball-loss improvement over random walk (%)", { size: 10, fill: INK2 });

  // end labels, nudged apart where two series finish within a line of text
  const ends = series.map(([key, label, colour, shape, w]) => ({ key, label, colour, shape, w, vals: skill(key) }));
  const labelY = ends.map((e) => y(e.vals[5]));
  labelY.push(y(0));
  const order = labelY.map((v, i) => i).sort((a, b) => labelY[a] - labelY[b]);
  for (let k = 1; k < order.length; k++)
    if (labelY[order[k]] - labelY[order[k - 1]] < 11.5) labelY[order[k]] = labelY[order[k - 1]] + 11.5;
  ends.forEach((e, i) => {
    s += polyline(e.vals.map((v, j) => [x(j + 1), y(v)]), e.colour, e.w);
    e.vals.forEach((v, j) => { s += marker(e.shape, x(j + 1), y(v), e.colour, 3); });
    s += line(x(6) + 5, y(e.vals[5]), W - m.r + 9, labelY[i], AXIS, 0.7);
    s += text(W - m.r + 12, labelY[i] + 3.5, e.label, { size: 10, weight: e.key === "hybrid" ? 700 : 400 });
  });
  s += text(W - m.r + 12, labelY[4] + 3.5, "Random walk", { size: 10, fill: INK2, italic: true });
  return { name: "fig_skill", w: W, h: H, body: svg(W, H, s), table: ends.map((e) => [e.key, ...e.vals.map((v) => v.toFixed(2))]) };
}

// ---------------------------------------------------------------------------
// Fig. 8 - out-of-sample forecasts against outcomes (Cat A)
// ---------------------------------------------------------------------------
function figBacktest() {
  const W = FULL, H = 226, m = { l: 40, r: 8, t: 38, b: 24 }, gap = 22;
  const pw = (W - m.l - m.r - gap) / 2;
  const when = (p) => { const d = new Date(p.month); return d.getUTCFullYear() + d.getUTCMonth() / 12 + (p.bidding_no - 1) / 24; };
  const y = scale(40000, 160000, H - m.b, m.t);
  let s = "";
  [["bt_A_hybrid_1.json", "(a) One exercise ahead"], ["bt_A_hybrid_6.json", "(b) Six exercises ahead (one quota quarter)"]].forEach(([file, title], i) => {
    const x0 = m.l + i * (pw + gap);
    const x = scale(2023.7, 2026.8, x0, x0 + pw);
    const pts = load(file).points;
    for (const v of [40000, 70000, 100000, 130000, 160000]) {
      s += line(x0, y(v), x0 + pw, y(v), v === 40000 ? AXIS : GRID);
      if (i === 0) s += text(x0 - 5, y(v) + 3.5, `${v / 1000}k`, { anchor: "end", size: 10, fill: INK2 });
    }
    for (const [t, label] of [[2024, "Jan 2024"], [2024.5, "Jul 2024"], [2025, "Jan 2025"], [2025.5, "Jul 2025"], [2026, "Jan 2026"], [2026.5, "Jul 2026"]]) {
      s += line(x(t), H - m.b, x(t), H - m.b + 3.5, AXIS);
      s += text(x(t), H - m.b + 15, label, { anchor: "middle", size: 9.5, fill: INK2 });
    }
    const upper = pts.map((p) => [x(when(p)), y(p.q90)]), lower = pts.map((p) => [x(when(p)), y(p.q10)]).reverse();
    s += `<path d="M${[...upper, ...lower].map(([a, b]) => `${n(a)},${n(b)}`).join("L")}z" fill="${C.blue}" fill-opacity="0.16"/>`;
    s += polyline(pts.map((p) => [x(when(p)), y(p.q50)]), C.blue, 1.8);
    s += polyline(pts.map((p) => [x(when(p)), y(p.actual)]), INK, 1.3);
    s += text(x0, m.t - 8, title, { size: 10.5, weight: 700 });
  });
  s += text(m.l - 34, 11, "Cat A premium (S$)", { size: 10, fill: INK2 });
  // legend
  let lx = W - 372;
  s += line(lx, 8, lx + 18, 8, INK, 1.3); s += text(lx + 23, 11.5, "Actual premium", { size: 10 }); lx += 104;
  s += line(lx, 8, lx + 18, 8, C.blue, 1.8); s += text(lx + 23, 11.5, "Median forecast", { size: 10 }); lx += 106;
  s += rect(lx, 3, 18, 10, C.blue, `fill-opacity="0.16"`); s += text(lx + 23, 11.5, "80% interval (p10 to p90)", { size: 10 });
  return { name: "fig_backtest", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
// Fig. 9 - TFT variable-selection weights
// ---------------------------------------------------------------------------
function figImportance() {
  const W = COL, top = 6, rowH = 15, labelW = 128;
  const data = load("model_interpretability.json");
  const panels = [["(a) Past inputs (encoder)", data.encoder], ["(b) Known-future inputs (decoder)", data.decoder]];
  const x = scale(0, 0.5, labelW, W - 40);
  let s = "", y = 12;
  for (const [title, rows] of panels) {
    s += text(0, y, title, { size: 10.5, weight: 700 });
    y += 8;
    rows.slice(0, top).forEach((r) => {
      s += text(labelW - 6, y + 10, r.label, { anchor: "end", size: 10 });
      const w = Math.max(x(r.importance) - labelW, 2);
      s += `<path d="M${labelW},${y + 3} h${n(w - 3)} a3,3 0 0 1 3,3 v3 a3,3 0 0 1 -3,3 h${n(-(w - 3))} z" fill="${C.blue}"/>`;
      s += text(labelW + w + 4, y + 10, `${(r.importance * 100).toFixed(1)}%`, { size: 10, fill: INK2 });
      y += rowH;
    });
    s += line(labelW, y - top * rowH, labelW, y + 1, AXIS);
    y += 22;
  }
  const H = y - 14;
  return { name: "fig_importance", w: W, h: H, body: svg(W, H, s) };
}

// ---------------------------------------------------------------------------
(async () => {
  const only = process.argv.slice(2);
  const figures = [figHistory, figArchitecture, figPipeline, figTft, figUi, figCv, figSkill, figBacktest, figImportance]
    .map((f) => f()).filter((f) => !only.length || only.includes(f.name));
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ deviceScaleFactor: 4, viewport: { width: 760, height: 600 } });
  const page = await context.newPage();
  for (const f of figures) {
    await page.setContent(`<html><body style="margin:0;background:#fff"><div id="fig" style="width:${f.w}px;height:${f.h}px;line-height:0">${f.body}</div></body></html>`);
    await page.locator("#fig").screenshot({ path: path.join(OUT, `${f.name}.png`) });
    console.log(`${f.name}.png  ${f.w}x${f.h}`, f.table ? JSON.stringify(f.table) : "");
  }
  await browser.close();
})();
