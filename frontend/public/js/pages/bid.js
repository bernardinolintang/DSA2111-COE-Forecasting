// Bid planner: the chance a reserve price clears the next exercise.
//
// COE bidding is a uniform-price auction: everyone who wins pays the same
// premium (the lowest successful bid). A bid wins if it is at least that
// premium, so P(win) = P(premium <= bid), read off the forecast distribution.
//
// The controls (slider, text box) respond instantly; what they drive is smoothed
// separately: the probability interpolates and the chart marker glides along
// the curve (only the marker is redrawn). A category change morphs the curve.

import { api } from "../api.js";
import { lineChart } from "../charts.js";
import { replaceHash, setPageActions, setView } from "../context.js";
import { explain } from "../glossary.js";
import { DURATION, animateNumber, lerp, reducedMotion, swap, tween } from "../motion.js";
import { buildHash } from "../route.js";
import { CATEGORY_CODES, errorBox, html, money, moneyShort, mount, onSegment, parseMoney, segmented } from "../util.js";

const MAX_BID = 999_999;
const shownProb = (p) => (p > 99.5 ? ">99" : p < 0.5 ? "<1" : String(Math.round(p)));

/** P(win) for a bid, by linear interpolation on the planner's curve (0-100). */
export function winProbability(curve, bid) {
  if (!curve.length) return 0;
  if (bid <= curve[0].bid) return 0;
  if (bid >= curve[curve.length - 1].bid) return 100;
  const i = curve.findIndex((p) => p.bid >= bid);
  const a = curve[i - 1];
  const b = curve[i];
  return a.probability_pct + ((bid - a.bid) / (b.bid - a.bid)) * (b.probability_pct - a.probability_pct);
}

export async function render(root, { category = "A", query = {} } = {}, page = {}) {
  const categories = await api.get("/categories");
  const state = { category: CATEGORY_CODES.includes(category) ? category : "A" };

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Bid planner</p>
      <h1 class="headline">How much should I bid?</h1>
      <p class="subtitle">Everyone who wins a COE pays the same premium, not their own bid. Bidding higher only buys certainty. See exactly how much.</p>
    </section>
    <section class="container">
      <div class="filters">
        <div class="filter"><span class="filter-label">Category</span>
          ${segmented("cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), state.category, "COE category")}</div>
      </div>
      <div class="split" id="planner" data-anchor="bid-planner" aria-busy="true">
        <div class="card card-lg"><div class="skeleton" style="height:320px"></div></div>
        <div class="card card-lg"><div class="skeleton" style="height:320px"></div></div>
      </div>
    </section>`);
  const planner = root.querySelector("#planner");
  const press = (value) => root.querySelectorAll('[data-seg="cat"] button')
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
  onSegment(root, "cat", (c) => { location.hash = buildHash({ page: "bid", category: c }); });
  root.querySelector('[data-seg="cat"]').addEventListener("pointerover", (e) => {
    const c = e.target.closest("button[data-value]")?.dataset.value;
    if (c) api.prefetch(`/bid-planner/${c}`);
  });
  setView({ category: state.category });

  // ---- planner state ----
  let plan = null;
  let curve = [];
  let lo = 0;
  let hi = 1;
  let chart = null;
  let els = null;                // the built planner's elements
  let current = null;            // the bid in the controls (exact)
  let markerAt = null;           // the bid the marker is drawn at (glides towards `current`)
  let glide = null;
  let hashTimer;
  let loadToken = 0;
  const prob = (bid) => winProbability(curve, bid);
  const clamp = (bid) => Math.max(lo, Math.min(hi, bid));

  function build() {
    mount(planner, html`
      <div class="card card-lg">
        <p class="eyebrow" id="bid-eyebrow"></p>
        <label class="small muted" for="bid-input">Your bid (reserve price)</label> ${explain("reserve-price", "reserve price")}
        <div class="money-input mt-8">$<input id="bid-input" inputmode="numeric" autocomplete="off"
          aria-describedby="bid-error" aria-label="Bid amount in dollars"></div>
        <p class="field-error" id="bid-error" role="alert" hidden></p>
        <input class="range" id="bid-range" type="range" step="100" aria-label="Bid amount slider">
        <div class="bid-hero mt-24">
          <div class="prob-figure" id="prob" aria-live="polite"><span class="prob-num">–</span><small>%</small></div>
          <p class="muted" id="prob-text"></p>
        </div>
        <p class="small muted mt-16">Expected premium (median): <strong id="bid-expected"></strong>. If you win, that is roughly what you pay, whatever you bid.</p>
        <p class="small mt-8 muted">Suggested reserve prices:</p>
        <div class="chips mt-8" id="bid-chips" data-anchor="bid-suggestions"></div>
      </div>
      <div class="card card-lg" data-anchor="bid-chart">
        <div class="card-head"><div><h2 class="title">Chance of winning ${explain("win-probability", "chance of winning")}</h2>
          <p class="card-sub" id="cdf-sub"></p></div></div>
        <div id="cdf"></div>
        <p class="caption mt-16">A higher bid does not change what you pay, but you commit to paying up to it if the premium spikes. The bid deposit and the rules for your category apply. Estimates, not guarantees.</p>
      </div>`);
    const $ = (s) => planner.querySelector(s);
    els = { eyebrow: $("#bid-eyebrow"), input: $("#bid-input"), range: $("#bid-range"), error: $("#bid-error"),
            prob: $("#prob"), probNum: $(".prob-num"), probText: $("#prob-text"), expected: $("#bid-expected"),
            chips: $("#bid-chips"), cdfSub: $("#cdf-sub"), cdf: $("#cdf") };

    els.range.addEventListener("input", () => set(+els.range.value, { duration: DURATION.micro }));
    els.input.addEventListener("input", () => {
      const r = parseMoney(els.input.value, { min: 1, max: MAX_BID, what: "a bid" });
      if (r.ok) set(r.value, { fromInput: true });
      else if (!r.empty) showError(r.error);
    });
    els.input.addEventListener("change", () => {
      const r = parseMoney(els.input.value, { min: 1, max: MAX_BID, what: "a bid" });
      if (r.ok) set(r.value);
      else { showError(r.error); if (current != null && r.empty) set(current); }
    });
    els.chips.addEventListener("click", (e) => {
      const b = e.target.closest("[data-bid]");
      if (b) set(+b.dataset.bid);
    });
  }

  const marker = (bid) => [{ x: clamp(bid), y: prob(clamp(bid)), color: "var(--accent)", guides: true }];

  /** Move the chart marker along the curve to `bid` (instantly on first draw or with reduced motion). */
  function moveMarker(bid, duration) {
    glide?.cancel();
    glide = null;
    const from = markerAt;
    markerAt = bid;
    if (from == null || reducedMotion() || from === bid) { chart.setPoints(marker(bid)); return; }
    glide = tween({ duration, onUpdate: (t) => chart.setPoints(marker(lerp(from, bid, t))) });
  }

  /** Apply a bid everywhere. fromInput: leave the text box alone while the user is typing. */
  function set(bid, { fromInput = false, duration = DURATION.tab, animate = true, moveChart = true } = {}) {
    bid = Math.round(bid);
    current = bid;
    if (!fromInput) els.input.value = new Intl.NumberFormat("en-SG").format(bid);
    const pos = clamp(bid);
    els.range.value = pos;
    const fill = ((pos - lo) / (hi - lo || 1)) * 100;
    els.range.style.background = `linear-gradient(90deg, var(--accent) ${fill}%, var(--surface-sunk) ${fill}%)`;
    const p = prob(bid);
    animateNumber(els.probNum, p, { format: shownProb, duration, animate });
    els.probText.textContent = `chance that a ${money(bid)} bid is at or above the ${plan.exercise.label} premium.`;
    if (moveChart) moveMarker(bid, duration);
    showError(null);
    clearTimeout(hashTimer);                  // browsers throttle rapid history updates
    const cat = state.category;
    hashTimer = setTimeout(() => { if (root.isConnected && cat === state.category) replaceHash(buildHash({ page: "bid", category: cat, bid })); }, 300);
    setView({ bid, facts: [
      { label: "Next exercise", value: plan.exercise.label },
      { label: "Your bid", value: money(bid) },
      { label: "Chance of winning", value: `${shownProb(p)}%` },
      { label: "Expected premium (median)", value: money(plan.expected_premium) },
    ] });
  }

  function showError(message) {
    els.error.hidden = !message;
    els.error.textContent = message || "";
    els.input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  /** Show a plan: first time builds the planner, later changes update it in place. */
  function show(next, bidQuery) {
    const firstShow = !els;
    if (firstShow) build();
    plan = next;
    curve = plan.curve;
    lo = Math.floor(curve[0].bid / 100) * 100;
    hi = Math.ceil(curve[curve.length - 1].bid / 100) * 100;
    const meta = categories.find((c) => c.code === state.category);
    const animate = !firstShow;

    swap(els.eyebrow, () => { els.eyebrow.textContent = `${meta.name} · next exercise: ${plan.exercise.label}`; },
      { key: `${meta.code}|${plan.exercise.label}`, animate });
    els.range.min = lo;
    els.range.max = hi;
    animateNumber(els.expected, plan.expected_premium, { format: money, animate });
    swap(els.chips, () => {
      mount(els.chips, html`${plan.suggestions.map((s) => html`
        <button class="chip" type="button" data-bid="${Math.round(s.bid)}">
          <div class="chip-top">${s.confidence_pct}% chance</div><div class="chip-val">${money(s.bid)}</div></button>`)}`);
    }, { key: meta.code, animate });
    els.cdfSub.textContent = `Probability that the premium ends at or below each bid, from the forecast for ${plan.exercise.label}.`;

    const initial = parseMoney(bidQuery ?? "", { min: 1, max: MAX_BID });
    const bid = Math.round(initial.ok ? initial.value : plan.bid);
    const series = [{ key: "p", label: "Win probability", color: "var(--accent)", points: curve.map((p) => ({ x: p.bid, y: p.probability_pct })) }];
    if (!chart) {
      // One chart for the page's lifetime: moving the bid only moves the marker.
      chart = lineChart(els.cdf, {
        xType: "linear", height: 280, label: "Win probability by bid", series, points: [],
        yFormat: (v) => `${Math.round(v)}%`, xFormat: moneyShort, yDomain: [0, 100],
        tooltip: (x) => ({ title: `Bid ${money(x)}`, rows: [{ value: `${prob(x).toFixed(0)}%`, label: "chance to win", color: "var(--accent)" }] }),
      });
      set(bid, { animate: false });
    } else {
      // New category: the curve and its marker morph together.
      glide?.cancel();
      markerAt = bid;
      chart.update({ series, points: marker(bid) }, { animate: true, duration: DURATION.route });
      set(bid, { moveChart: false });
    }
  }

  async function load(bidQuery) {
    const token = ++loadToken;
    const cat = state.category;
    planner.setAttribute("aria-busy", "true");
    planner.classList.add("is-loading");
    let next;
    try {
      next = await api.get(`/bid-planner/${cat}`);
      if (!next.curve?.length) throw new Error("No forecast is available for this category yet.");
    } catch (err) {
      if (token !== loadToken || !root.isConnected) return;
      glide?.cancel();
      chart?.destroy();
      chart = null;
      els = null;
      markerAt = null;
      mount(planner, errorBox(err));
      planner.removeAttribute("aria-busy");
      planner.classList.remove("is-loading");
      return;
    }
    if (token !== loadToken || !root.isConnected) return;
    show(next, bidQuery);
    planner.removeAttribute("aria-busy");
    planner.classList.remove("is-loading");
  }

  page.navigate = ({ category: c, query: q = {} }) => {
    const next = CATEGORY_CODES.includes(c) ? c : "A";
    press(next);
    if (next === state.category) {
      const r = parseMoney(q.bid ?? "", { min: 1, max: MAX_BID });
      if (r.ok && els && r.value !== current) set(r.value);
      return true;
    }
    state.category = next;
    setView({ category: next, bid: null, facts: [] });
    load(q.bid);
    return true;
  };
  setPageActions({ setBid: (amount) => { if (els) set(amount); } });

  await load(query.bid);
  return () => { clearTimeout(hashTimer); glide?.cancel(); chart?.destroy(); };
}
