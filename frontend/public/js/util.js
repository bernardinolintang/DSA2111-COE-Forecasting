// Small helpers shared by every page: safe HTML templating, number formatting,
// dates, and per-viewer storage.

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

export const money = (v) => (v == null || Number.isNaN(v) ? "—" : `$${nf0.format(Math.round(v))}`);
export const number = (v) => (v == null ? "—" : nf0.format(v));

/** $131.9k style, for axes and tight spaces. */
export function moneyShort(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `$${Math.round(v / 1e3)}k`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

export function pct(v, { sign = true, digits = 1 } = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = digits === 1 ? nf1.format(Math.abs(v)) : nf0.format(Math.abs(v));
  const prefix = !sign ? (v < 0 ? "−" : "") : v > 0 ? "+" : v < 0 ? "−" : "";
  return `${prefix}${s}%`;
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

// Inline icons (SF Symbols-like strokes).
export const ICONS = {
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  sun: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
  trash: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`,
};

export function signalPill(signal) {
  if (!signal) return html`<span class="pill pill-neutral">No forecast</span>`;
  return signal.action === "wait"
    ? html`<span class="pill pill-wait">${raw(ICONS.clock)}Wait</span>`
    : html`<span class="pill pill-buy">${raw(ICONS.check)}Buy now</span>`;
}

export function segmented(name, options, active, label) {
  return html`<div class="segmented" role="group" aria-label="${label}" data-seg="${name}">
    ${options.map((o) => html`<button type="button" data-value="${o.value}" aria-pressed="${o.value === active}">${o.label}</button>`)}
  </div>`;
}

/** Wire a segmented control rendered by segmented(); calls onChange(value). */
export function onSegment(root, name, onChange) {
  const group = root.querySelector(`[data-seg="${name}"]`);
  if (!group) return;
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    onChange(btn.dataset.value);
  });
}

export function errorBox(err) {
  return html`<div class="error-box">${err?.message || "Something went wrong."}</div>`;
}
