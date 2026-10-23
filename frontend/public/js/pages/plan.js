// My plan: the forecast turned into a short personal summary.
//
// The visitor says what they are planning (buying or renewing), their category,
// when, and optionally a COE budget. The page answers with the market outlook,
// the forecast range for their timing, how the budget compares, a level worth
// watching and, for renewals, an estimate of the renewal price (PQP).
//
// Their answers stay in this browser (localStorage "coe-plan"). Nothing is sent
// to the server except a watchlist target they choose to add.

import { api } from "../api.js";
import { setView } from "../context.js";
import { cdfAt, pqpPath } from "../forecast-math.js";
import { explain } from "../glossary.js";
import { enter } from "../motion.js";
import {
  CATEGORY_CODES, UNCERTAINTY, clientId, errorBox, forecastId, html, money, mount, noticeBox, onSegment,
  outlookPill, parseMoney, provenance, rangeShort, segmented, store, toast,
} from "../util.js";

const KEY = "coe-plan";
const INTENTS = [
  { value: "buy", label: "Buying a car" }, { value: "renew", label: "Renewing COE" }, { value: "explore", label: "Exploring" },
];
const TIMINGS = [
  { value: "next", label: "Next exercise" }, { value: "quarter", label: "In 3 months" }, { value: "later", label: "Not sure yet" },
];
const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-SG", { month: "short", year: "numeric", timeZone: "UTC" });
const chance = (p) => (p > 0.995 ? "over 99%" : p < 0.005 ? "under 1%" : `${Math.round(p * 100)}%`);
/** A round level to watch: $1,000 steps for cars, $100 for motorcycles. */
const roundLevel = (v) => { const step = v < 30_000 ? 100 : 1000; return Math.round(v / step) * step; };

export async function render(root, { query = {} } = {}) {
  const saved = store.get(KEY, {}) || {};
  const state = {
    intent: INTENTS.some((i) => i.value === query.intent) ? query.intent : INTENTS.some((i) => i.value === saved.intent) ? saved.intent : "buy",
    category: CATEGORY_CODES.includes(saved.category) ? saved.category : "A",
    timing: TIMINGS.some((t) => t.value === saved.timing) ? saved.timing : "next",
    budget: Number.isFinite(saved.budget) && saved.budget > 0 ? saved.budget : null,
  };
  const categories = await api.get("/categories");
  const metaOf = (c) => categories.find((x) => x.code === c);

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">My plan</p>
      <h1 class="headline">Tell us what you're planning.</h1>
      <p class="subtitle">Answer a few questions and COE Compass puts the forecast in terms of your situation. Your answers stay in this browser.</p>
    </section>
    <section class="container">
      <div class="split split-plan mt-24">
        <form class="card card-lg plan-form" id="plan-form" novalidate data-anchor="plan-form">
          <div class="field"><span class="field-label" id="plan-intent-label">I am</span>
            ${segmented("intent", INTENTS, state.intent, "What you are planning")}</div>
          <div class="field"><span class="field-label">COE category ${explain("categories", "COE categories")}</span>
            ${segmented("plan-cat", CATEGORY_CODES.map((c) => ({ value: c, label: `Cat ${c}` })), state.category, "COE category")}
            <p class="caption" id="plan-cat-note"></p></div>
          <div class="field" id="plan-timing-field"><span class="field-label">Target purchase</span>
            ${segmented("timing", TIMINGS, state.timing, "When you plan to buy")}</div>
          <div class="field" id="plan-budget-field"><label for="plan-budget">COE budget (optional)</label>
            <div class="money-input">$<input id="plan-budget" inputmode="numeric" autocomplete="off" placeholder="e.g. 130,000"
              aria-describedby="plan-budget-error plan-budget-help" aria-invalid="false"
              value="${state.budget ? new Intl.NumberFormat("en-SG").format(state.budget) : ""}"></div>
            <p class="field-error" id="plan-budget-error" role="alert" hidden></p>
            <p class="caption" id="plan-budget-help">The most you would want the COE itself to cost, not the whole car.</p></div>
        </form>
        <div class="card card-lg plan-result" id="plan-result" aria-live="polite" aria-busy="true">
          <div class="skeleton" style="height:340px"></div>
        </div>
      </div>
    </section>`);

  const $ = (sel) => root.querySelector(sel);
  const result = $("#plan-result");
  const budgetInput = $("#plan-budget");
  const budgetError = $("#plan-budget-error");
  let data = null;               // { card, forecast, history } for state.category
  let loadToken = 0;
  let firstPaint = true;

  const save = () => store.set(KEY, state);

  function paintForm() {
    const m = metaOf(state.category);
    const renew = state.intent === "renew";
    $("#plan-cat-note").textContent = renew && state.category === "E"
      ? "Cat E is an open category for bidding only. A COE is renewed at the PQP of the vehicle's own category (A to D), so choose that."
      : `${m.title}: ${m.description}`;
    $("#plan-timing-field").hidden = renew;
    $("#plan-budget-field").hidden = renew;
  }

  // ---- the plan ----
  const row = (label, body, term) => html`<div class="plan-row"><dt>${label}${term ? html` ${explain(term[0], term[1])}` : ""}</dt><dd>${body}</dd></div>`;

  function budgetRow(next, end) {
    if (!state.budget) {
      return row("Your budget", html`<span class="muted">Add a COE budget on the left to see how it compares with the forecast.</span>`);
    }
    const b = state.budget;
    const diff = b - next.q50;
    const where = Math.abs(diff) < 50 ? "right at" : `${money(Math.abs(diff))} ${diff > 0 ? "above" : "below"}`;
    return row("Your budget", html`
      <strong>${money(b)}</strong> is ${where} the median forecast for the next exercise.
      <ul class="plan-list">
        <li>${next.label}: about a <strong>${chance(cdfAt(next, b))}</strong> chance the premium is at or below your budget.</li>
        <li>${end.label}: about <strong>${chance(cdfAt(end, b))}</strong>.</li>
      </ul>`);
  }

  function buyPlan() {
    const { card, forecast } = data;
    const s = card.signal;
    const [next] = forecast.steps;
    const end = forecast.steps[forecast.steps.length - 1];
    const quarter = state.timing !== "next";
    const watch = roundLevel(state.budget && state.budget < card.latest.premium ? state.budget : next.q25);
    const watchWhy = state.budget && state.budget < card.latest.premium
      ? "your budget"
      : "the lower quartile of the next-exercise forecast, a level the model gives about a 1-in-4 chance";
    return html`
      <dl class="plan-rows">
        ${row("Market outlook", html`${outlookPill(s)}<p class="plan-note">${s.summary}</p>`, ["outlook", "market outlook"])}
        ${row("Next exercise", html`<strong>${next.label}</strong> <span class="muted">· latest premium ${money(card.latest.premium)} (${card.latest.label})</span>`)}
        ${row("COE forecast", html`
          <ul class="plan-list">
            <li class="${quarter ? "" : "is-focus"}"><strong>${rangeShort(next.q10, next.q90)}</strong> likely range at the next exercise <span class="muted">(median ${money(next.q50)})</span></li>
            <li class="${quarter ? "is-focus" : ""}"><strong>${rangeShort(end.q10, end.q90)}</strong> by ${end.label} <span class="muted">(median ${money(end.q50)})</span></li>
          </ul>
          ${state.timing === "later" ? html`<p class="plan-note">COE Compass forecasts one quota quarter ahead, to ${end.label}. For anything later, a watchlist target is the honest tool: it is re-scored after every exercise.</p>` : ""}`,
          ["range-80", "80% range"])}
        ${row("Model uncertainty", html`<strong>${UNCERTAINTY[s.uncertainty]}</strong> <span class="muted">· the 80% range by ${end.label} is ±${Math.round(s.uncertainty_pct)}% of today's premium</span>`,
          ["uncertainty", "model uncertainty"])}
        ${budgetRow(next, end)}
        ${row("Watch level", html`<strong>${money(watch)}</strong> <span class="muted">· ${watchWhy}</span>
          <div class="mt-8"><button type="button" class="btn btn-sm" id="plan-watch" data-target="${watch}">Watch Cat ${state.category} below ${money(watch)}</button></div>`,
          ["watchlist", "watchlist"])}
      </dl>
      <div class="plan-next">
        <a class="link-arrow" href="#/bid/${state.category}${state.budget ? `?bid=${state.budget}` : ""}">${state.budget ? "See your budget as a bid" : "Plan a bid"}</a>
        <a class="link-arrow" href="#/scenario/${state.category}">What if supply changes?</a>
        <a class="link-arrow" href="#/forecast/${state.category}">Full Cat ${state.category} forecast</a>
      </div>`;
  }

  function renewPlan() {
    const { card, forecast, history } = data;
    if (state.category === "E") {
      return noticeBox({ title: "Choose your vehicle's category",
        body: "A COE is renewed at the Prevailing Quota Premium of the vehicle's own category (A to D). Cat E is used for bidding only." });
    }
    const path = pqpPath(history, forecast.steps);
    if (!path.length) {
      return noticeBox({ title: "Not enough recent results to estimate the PQP", body: "The estimate needs three full months of bidding results.", tone: "warn" });
    }
    const [now] = path;
    const last = path[path.length - 1];
    const drift = last.value - now.value;
    const s = card.signal;
    return html`
      <dl class="plan-rows">
        ${row("Renewal price today", html`<strong class="plan-figure">${money(now.value)}</strong>
          <p class="plan-note">Estimated PQP for ${monthName(now.month)}: the average premium of the ${now.actual + now.forecast} bidding exercises in the three months before it${now.forecast ? `, ${now.forecast} of them forecast` : ", all recorded"}.</p>`,
          ["pqp", "Prevailing Quota Premium"])}
        ${row("Where it may be heading", html`
          <div class="table-wrap"><table class="data"><thead><tr><th>Renew in</th><th class="num">10 years</th><th class="num">5 years</th><th>Based on</th></tr></thead>
            <tbody>${path.map((p) => html`<tr><td>${monthName(p.month)}</td><td class="num">${money(p.value)}</td><td class="num">${money(p.value / 2)}</td>
              <td>${!p.forecast ? "Recorded" : !p.actual ? "All forecast" : `${p.forecast} of ${p.actual + p.forecast} forecast`}</td></tr>`)}</tbody></table></div>
          ${path.length > 1 ? html`<p class="plan-note">On the model's median forecast, the PQP ${Math.abs(drift) < now.value * 0.002 ? "stays about level" : `${drift > 0 ? "rises" : "falls"} by about ${money(Math.abs(drift))}`} between ${monthName(now.month)} and ${monthName(last.month)}. Months that use forecast values carry the forecast's uncertainty.</p>` : ""}`)}
        ${row("Market outlook", html`${outlookPill(s)}<p class="plan-note">${s.summary}</p>`, ["outlook", "market outlook"])}
        ${row("Good to know", html`<ul class="plan-list">
          <li>A 5-year renewal costs half the PQP, but that COE cannot be renewed again.</li>
          <li>The PQP follows bidding results with a lag, so a fall in premiums shows up in it over the next three months.</li>
          <li>This is an estimate from published results. LTA publishes the official PQP; check it before you pay.</li></ul>`)}
      </dl>
      <div class="plan-next">
        <a class="link-arrow" href="#/forecast/${state.category}">Full Cat ${state.category} forecast</a>
        <a class="link-arrow" href="#/learn">How renewal works</a>
      </div>`;
  }

  function paint() {
    if (!data) return;
    const m = metaOf(state.category);
    const { card, forecast } = data;
    const title = state.intent === "renew" ? "Your renewal outlook" : "Your COE plan";
    const body = !card?.signal || !forecast
      ? noticeBox({ title: "Latest forecast temporarily unavailable", tone: "warn", retry: true,
          body: card ? `Recorded results remain available: the latest Cat ${state.category} premium was ${money(card.latest.premium)} (${card.latest.label}).` : "" })
      : state.intent === "renew" ? renewPlan() : buyPlan();
    mount(result, html`
      <p class="eyebrow" style="margin:0">${title}</p>
      <h2 class="title plan-title">${m.name} · ${m.title}</h2>
      ${body}
      ${forecast ? provenance({ run: forecast.run, dataThrough: forecast.origin.label, id: forecastId(state.category, forecast.steps[0], forecast.run) }) : ""}
      <p class="caption mt-16">A planning aid built on a forecast of the COE premium only. It is not financial advice, and it does not tell you to buy or to wait.</p>`);
    result.removeAttribute("aria-busy");
    if (!firstPaint) enter(result.querySelector(".plan-rows, .notice"), { rise: 4 });
    firstPaint = false;
    const s = card?.signal;
    setView({ category: state.category, facts: [
      { label: "Planning", value: INTENTS.find((i) => i.value === state.intent).label },
      { label: "Category", value: m.name },
      ...(s ? [{ label: "Outlook", value: s.label }, { label: "Next exercise median", value: money(card.next_q50) }] : []),
      ...(state.budget && state.intent !== "renew" ? [{ label: "COE budget", value: money(state.budget) }] : []),
    ] });
  }

  async function load() {
    const token = ++loadToken;
    const cat = state.category;
    result.setAttribute("aria-busy", "true");
    try {
      const [summary, forecast, history] = await Promise.all([
        api.get("/summary"), api.get(`/forecast/${cat}?scenario=base`).catch(() => null), api.get(`/history/${cat}?years=1`),
      ]);
      if (token !== loadToken || !root.isConnected) return;
      data = { card: summary.categories.find((c) => c.code === cat), forecast, history: history.points };
      paint();
    } catch (err) {
      if (token !== loadToken || !root.isConnected) return;
      data = null;
      mount(result, errorBox(err, "Your plan couldn't be loaded"));
      result.removeAttribute("aria-busy");
    }
  }

  onSegment(root, "intent", (v) => { state.intent = v; save(); paintForm(); paint(); });
  onSegment(root, "timing", (v) => { state.timing = v; save(); paint(); });
  onSegment(root, "plan-cat", (c) => { state.category = c; save(); paintForm(); load(); });
  budgetInput.addEventListener("input", () => {
    const r = parseMoney(budgetInput.value, { what: "a budget" });
    const invalid = !r.ok && !r.empty;
    budgetError.hidden = !invalid;
    budgetError.textContent = invalid ? r.error : "";
    budgetInput.setAttribute("aria-invalid", String(invalid));
    if (invalid) return;
    state.budget = r.ok ? r.value : null;
    save();
    paint();
  });
  budgetInput.addEventListener("blur", () => {
    if (state.budget && budgetInput.getAttribute("aria-invalid") !== "true") budgetInput.value = new Intl.NumberFormat("en-SG").format(state.budget);
  });
  $("#plan-form").addEventListener("submit", (e) => e.preventDefault());

  // "Watch this level": the one thing this page saves on the server, and only on click.
  result.addEventListener("click", async (e) => {
    const btn = e.target.closest("#plan-watch");
    if (!btn || btn.disabled) return;
    const target = Number(btn.dataset.target);
    btn.disabled = true;
    try {
      await api.post("/alerts", { client_id: clientId(), category: state.category, direction: "below", target, label: "From my COE plan" });
      btn.textContent = "Added to your watchlist";
      toast(`Watching Cat ${state.category} below ${money(target)}`);
      document.dispatchEvent(new CustomEvent("coe:watchlist-changed"));
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  });

  paintForm();
  save();
  setView({ category: state.category });
  await load();
  return undefined;
}
