// Small helpers shared by every page: safe HTML templating, number formatting,
// dates, per-viewer storage, and the few components every page uses (outlook
// pill, driver chips, forecast details line, notices).

import { attachThumb } from "./motion.js";

// ---------------------------------------------------------------------------
// Safe HTML: every interpolated value is escaped unless wrapped in raw().
// ---------------------------------------------------------------------------
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
export const raw = (value) => new Raw(value);

function render(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === false || value === null || value === undefined) return "";
  return esc(value);
}

/** Tagged template: html`<p>${userText}</p>` escapes userText. */
export function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ""), ""));
}

export function mount(el, template) {
  el.innerHTML = String(template);
  return el;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------
const nf0 = new Intl.NumberFormat("en-SG", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-SG", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const bad = (v) => v == null || typeof v !== "number" || !Number.isFinite(v);
export const money = (v) => (bad(v) ? "—" : `$${nf0.format(Math.round(v))}`);
export const number = (v) => (bad(v) ? "—" : nf0.format(v));

/** $131.9k style, for axes and tight spaces. */
export function moneyShort(v) {
  if (bad(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `$${Math.round(v / 1e3)}k`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

/** "$126k–$142k", or "—" when either end is missing. */
export const rangeShort = (lo, hi) => (bad(lo) || bad(hi) ? "—" : `${moneyShort(lo)}–${moneyShort(hi)}`);

export function pct(v, { sign = true, digits = 1 } = {}) {
  if (bad(v)) return "—";
  const s = digits === 1 ? nf1.format(Math.abs(v)) : nf0.format(Math.abs(v));
  if (Number(s) === 0) return `${s}%`;   // no "−0.0%" for changes that round to nothing
  const prefix = !sign ? (v < 0 ? "−" : "") : v > 0 ? "+" : v < 0 ? "−" : "";
  return `${prefix}${s}%`;
}

/**
 * Parse a dollar amount typed or pasted by a person: "100000", "100,000",
 * "$100,000", "$ 95,000.00" and "95k" are all accepted. Anything else
 * (letters, negatives, zero, blanks) is rejected with a message to show.
 * Returns { ok: true, value } or { ok: false, error, empty }.
 */
export function parseMoney(input, { min = 1, max = 999_999, what = "a COE premium" } = {}) {
  const s = String(input ?? "").trim().replace(/^S\$/i, "$");
  const range = `between ${money(min)} and ${money(max)}`;
  if (!s) return { ok: false, empty: true, error: `Enter ${what} ${range}.` };
  if (/^-\s*\$?\s*\d/.test(s)) return { ok: false, error: `Enter ${what} above $0.` };
  const m = s.match(/^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k)?$/i);
  if (!m) return { ok: false, error: `Enter ${what} using numbers only, e.g. 95,000.` };
  let value = Number(m[1].replace(/,/g, "") + (m[2] || ""));
  if (m[3]) value *= 1000;
  value = Math.round(value);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { ok: false, error: `Enter ${what} ${range}.` };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Dates: an exercise is (month, bidding_no). For plotting we place the 1st
// exercise on the 7th and the 2nd on the 21st of the month.
// ---------------------------------------------------------------------------
export function exerciseDate(month, biddingNo) {
  const [y, m] = String(month).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, biddingNo === 1 ? 7 : 21));
}

export const monthYear = (d) => d.toLocaleDateString("en-SG", { month: "short", year: "numeric", timeZone: "UTC" });

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sgtParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Singapore", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/**
 * A timestamp in Singapore time, e.g. "30 Sep 2026, 23:09 SGT" (year: false drops the year).
 * Month names are fixed here so they match the exercise labels in every browser locale.
 */
export function sgt(iso, { year = true } = {}) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "—";
  const p = Object.fromEntries(sgtParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]}${year ? ` ${p.year}` : ""}, ${p.hour}:${p.minute} SGT`;
}

// ---------------------------------------------------------------------------
// Per-viewer storage. Can throw (private mode, blocked storage), so always guarded.
// ---------------------------------------------------------------------------
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export function clientId() {
  let id = store.get("coe-client-id");
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID()
      : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
    store.set("coe-client-id", id);
  }
  return id;
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

export const CATEGORY_CODES = ["A", "B", "C", "D", "E"];
export const catColor = (code) => `var(--cat-${code})`;

// Inline icons (simple strokes).
const icon = (body, { size = 18, width = 2 } = {}) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  check: icon('<path d="M5 12.5l4.2 4.2L19 7"/>', { width: 2.4 }),
  clock: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', { width: 2.2 }),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: icon('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  trash: icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  bell: icon('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>', { width: 2.2 }),
  help: icon('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17.2h.01"/>'),
  sparkle: icon('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>', { width: 2.2 }),
  send: icon('<path d="M5 12h13M13 6l6 6-6 6"/>', { width: 2.2 }),
  up: icon('<path d="M6 17L17 6M9 6h8v8"/>', { width: 2.4 }),
  down: icon('<path d="M6 7l11 11M17 10v8H9"/>', { width: 2.4 }),
  flat: icon('<path d="M4 12h16M14 6l6 6-6 6"/>', { width: 2.4 }),
  car: icon('<path d="M4 16v-3.5l2-5A2 2 0 0 1 7.9 6h8.2a2 2 0 0 1 1.9 1.5l2 5V16"/><path d="M3 16h18v2H3zM4 12.5h16"/><path d="M7 18v1.5M17 18v1.5"/>'),
  renew: icon('<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5"/><path d="M4 20v-4.5h4.5"/>'),
  gavel: icon('<path d="M13.5 5.5l5 5M10 9l5 5M11.8 3.8l8.4 8.4M8.3 7.3l8.4 8.4M9.5 12.5L3.5 18.5a1.4 1.4 0 0 0 2 2l6-6M13 21h8"/>'),
  chart: icon('<path d="M4 4v16h16"/><path d="M7.5 15l3.5-4 3 2.5L19 8"/>'),
};

// ---------------------------------------------------------------------------
// Market outlook: which way the forecast leans, and how clearly. Never advice.
// ---------------------------------------------------------------------------
const TREND_WORD = { up: "up", down: "down", flat: "steady" };
export const UNCERTAINTY = { low: "Low", moderate: "Moderate", high: "High" };

/** The outlook as a pill: arrow + words; a slight lean is outlined, a clear one filled. */
export function outlookPill(signal) {
  if (!signal) return html`<span class="pill pill-neutral">No forecast</span>`;
  const cls = `pill pill-${signal.direction}${signal.strength === "slight" ? " pill-soft" : ""}`;
  return html`<span class="${cls}" title="${signal.summary || ""}">${raw(ICONS[signal.direction] || ICONS.flat)}${signal.label}</span>`;
}

/** A driver in a few words, e.g. "Quota down 6% on a year ago". */
export function driverText(d) {
  if (d.key === "quota") {
    return d.trend === "flat" ? "Quota steady on a year ago" : `Quota ${TREND_WORD[d.trend]} ${Math.abs(Math.round(d.value))}% on a year ago`;
  }
  if (d.key === "demand") {
    return d.trend === "flat" ? "Demand in line with its 1-year average" : `Demand ${d.trend === "up" ? "above" : "below"} its 1-year average`;
  }
  return `${UNCERTAINTY[d.trend] || d.trend} uncertainty`;
}

/** The "why" behind an outlook as short chips; the full sentence is the tooltip. */
export function driverChips(drivers = []) {
  const short = (d) => (d.key === "quota" ? `Quota ${d.trend === "flat" ? "steady" : `${d.trend === "up" ? "↑" : "↓"}${Math.abs(Math.round(d.value))}%`}`
    : d.key === "demand" ? `Demand ${d.trend === "up" ? "↑" : d.trend === "down" ? "↓" : "steady"}`
    : `Uncertainty ${d.trend}`);
  return html`<ul class="drivers" aria-label="What is behind this outlook">${drivers.map((d) =>
    html`<li class="driver" title="${d.title}: ${d.text}"><span class="visually-hidden">${driverText(d)}. </span><span aria-hidden="true">${short(d)}</span></li>`)}</ul>`;
}

/**
 * Where a forecast came from: when it was produced, the last result it includes,
 * the model run and the source. Shown under every forecast.
 */
export function forecastId(category, step, run) {
  if (!category || !step || !run) return null;
  return `${category}-${String(step.month).slice(0, 7)}-E${step.bidding_no}-r${run.id}`;
}

export function provenance({ run, dataThrough, id = null } = {}) {
  if (!run) return html`<p class="provenance">Forecast details unavailable.</p>`;
  return html`<dl class="provenance" aria-label="Forecast details">
    <div><dt>Last updated</dt><dd>${sgt(run.finished_at || run.created_at)}</dd></div>
    ${dataThrough ? html`<div><dt>Data through</dt><dd>${dataThrough}</dd></div>` : ""}
    <div><dt>Model</dt><dd>Hybrid TFT + Box-Tiao · run #${run.id}</dd></div>
    ${id ? html`<div><dt>Forecast ID</dt><dd class="mono">${id}</dd></div>` : ""}
    <div><dt>Source</dt><dd>LTA via data.gov.sg · <a href="#/learn/sources">View data sources</a></dd></div>
  </dl>`;
}

export function segmented(name, options, active, label) {
  return html`<div class="segmented" role="group" aria-label="${label}" data-seg="${name}">
    ${options.map((o) => html`<button type="button" data-value="${o.value}" aria-pressed="${o.value === active}">${o.label}</button>`)}
  </div>`;
}

/**
 * Wire a segmented control rendered by segmented(); calls onChange(value).
 * The selection is drawn by a thumb that slides to whichever button is pressed,
 * however it was pressed (click, a page action, the analyst).
 */
export function onSegment(root, name, onChange) {
  const group = root.querySelector(`[data-seg="${name}"]`);
  if (!group) return;
  attachThumb(group);
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    onChange(btn.dataset.value);
  });
}

// ---------------------------------------------------------------------------
// States: a page never shows a blank where data should be.
// ---------------------------------------------------------------------------
/** A calm notice: what happened, what still works, and (optionally) what to do. */
export function noticeBox({ title, body = "", tone = "info", retry = false }) {
  return html`<div class="notice notice-${tone}" role="${tone === "error" ? "alert" : "status"}">
    <div><strong>${title}</strong>${body ? html`<p>${body}</p>` : ""}</div>
    ${retry ? html`<button type="button" class="btn btn-ghost btn-sm" data-reload>Try again</button>` : ""}
  </div>`;
}

export function errorBox(err, title = "This couldn't be loaded") {
  return noticeBox({ title, body: err?.message || "Something went wrong.", tone: "error", retry: true });
}
