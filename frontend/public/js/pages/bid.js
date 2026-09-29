// Bid planner: the chance a reserve price clears the next exercise.
//
// COE bidding is a uniform-price auction: everyone who wins pays the same
// premium (the lowest successful bid). A bid wins if it is at least that
// premium, so P(win) = P(premium <= bid), read off the forecast distribution.

import { api } from "../api.js";
import { lineChart } from "../charts.js";
import { CATEGORY_CODES, errorBox, html, money, moneyShort, mount, onSegment, segmented } from "../util.js";

export async function render(root, { category = "A" } = {}) {
  category = CATEGORY_CODES.includes(category) ? category : "A";
  const categories = await api.get("/categories");
  const meta = categories.find((c) => c.code === category);

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Bid planner</p>
      <h1 class="headline">How much should I bid?</h1>
      <p class="subtitle">Everyone who wins a COE pays the same premium, not their own bid. Bidding higher only buys certainty. See exactly how much.</p>
    </section>
    <section class="container">
      <div class="filters">
        <div class="filter"><span class="filter-label">Category</span>
          ${segmented("cat", CATEGORY_CODES.map((c) => ({ value: c, label: c })), category, "COE category")}</div>
      </div>
      <div class="split" id="planner"><div class="card card-lg"><div class="skeleton" style="height:320px"></div></div></div>
    </section>`);
  onSegment(root, "cat", (c) => { location.hash = `#/bid/${c}`; });

  let plan;
  try {
    plan = await api.get(`/bid-planner/${category}`);
  } catch (err) {
    mount(root.querySelector("#planner"), errorBox(err));
    return undefined;
  }

  const curve = plan.curve;
  const lo = Math.floor(curve[0].bid / 100) * 100;
  const hi = Math.ceil(curve[curve.length - 1].bid / 100) * 100;
  const prob = (bid) => {
    if (bid <= curve[0].bid) return 0;
    if (bid >= curve[curve.length - 1].bid) return 100;
    const i = curve.findIndex((p) => p.bid >= bid);
    const a = curve[i - 1];
    const b = curve[i];
    return a.probability_pct + ((bid - a.bid) / (b.bid - a.bid)) * (b.probability_pct - a.probability_pct);
  };

  mount(root.querySelector("#planner"), html`
    <div class="card card-lg">
      <p class="eyebrow">${meta.name} · next exercise: ${plan.exercise.label}</p>
      <label class="small muted" for="bid-input">Your bid (reserve price)</label>
      <div class="money-input mt-8">$<input id="bid-input" inputmode="numeric" autocomplete="off" aria-label="Bid amount in dollars"></div>
      <input class="range" id="bid-range" type="range" min="${lo}" max="${hi}" step="100" aria-label="Bid amount slider">
      <div class="bid-hero mt-24">
        <div class="prob-figure" id="prob" aria-live="polite">–</div>
        <p class="muted" id="prob-text"></p>
      </div>
      <p class="small muted mt-16">Expected premium (median): <strong>${money(plan.expected_premium)}</strong>. If you win, that is roughly what you pay, whatever you bid.</p>
      <p class="small mt-8 muted">Suggested reserve prices:</p>
      <div class="chips mt-8">${plan.suggestions.map((s) => html`
        <button class="chip" type="button" data-bid="${Math.round(s.bid)}">
          <div class="chip-top">${s.confidence_pct}% chance</div><div class="chip-val">${money(s.bid)}</div></button>`)}</div>
    </div>
    <div class="card card-lg">
      <div class="card-head"><div><h2 class="title">Chance of winning</h2>
        <p class="card-sub">Probability that the premium ends at or below each bid, from the forecast for ${plan.exercise.label}.</p></div></div>
      <div id="cdf"></div>
      <p class="tiny mt-16">A higher bid does not change what you pay, but you commit to paying up to it if the premium spikes. The bid deposit and the rules for your category apply.</p>
    </div>`);

  const input = root.querySelector("#bid-input");
  const range = root.querySelector("#bid-range");
  let chart;

  function drawCurve(bid) {
    chart?.destroy();
    chart = lineChart(root.querySelector("#cdf"), {
      xType: "linear", height: 280, label: "Win probability by bid",
      series: [{ key: "p", label: "Win probability", color: "var(--accent)", points: curve.map((p) => ({ x: p.bid, y: p.probability_pct })) }],
      points: [{ x: bid, y: prob(bid), color: "var(--accent)" }],
      yFormat: (v) => `${Math.round(v)}%`, xFormat: moneyShort, yDomain: [0, 100],
      tooltip: (x) => ({ title: `Bid ${money(x)}`, rows: [{ value: `${prob(x).toFixed(0)}%`, label: "chance to win", color: "var(--accent)" }] }),
    });
  }

  function set(bid, { redraw = true } = {}) {
    bid = Math.max(lo, Math.min(hi, Math.round(bid)));
    input.value = new Intl.NumberFormat("en-SG").format(bid);
    range.value = bid;
    const p = prob(bid);
    const shown = p > 99.5 ? ">99" : p < 0.5 ? "<1" : Math.round(p);
    mount(root.querySelector("#prob"), html`${shown}<small>%</small>`);
    root.querySelector("#prob-text").textContent = `chance that a ${money(bid)} bid is at or above the ${plan.exercise.label} premium.`;
    const pct = ((bid - lo) / (hi - lo)) * 100;
    range.style.background = `linear-gradient(90deg, var(--accent) ${pct}%, var(--surface-sunk) ${pct}%)`;
    if (redraw) drawCurve(bid);
  }

  range.addEventListener("input", () => set(+range.value));
  input.addEventListener("change", () => set(+input.value.replace(/[^0-9.]/g, "") || plan.bid));
  root.querySelectorAll("[data-bid]").forEach((b) => b.addEventListener("click", () => set(+b.dataset.bid)));
  set(plan.bid);
  return () => chart?.destroy();
}
