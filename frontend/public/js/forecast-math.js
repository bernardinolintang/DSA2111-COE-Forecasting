// Pure forecast arithmetic used by the Scenario Lab, the Bid planner and My plan.
// No DOM, so it is unit-tested in Node (tests/unit/forecast-math.test.js).

// these are the stored quantile columns so that the loops below stay short
const QUANTILES = ["q05", "q10", "q25", "q50", "q75", "q90", "q95"];
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Supply scenarios
// ---------------------------------------------------------------------------
/**
 * Forecast steps for a quota change of `pct` percent, from the modelled runs.
 * `runs`: [{ pct, steps }] (the model is run at -20, -10, 0, +10, +20). A point
 * between two runs is a straight line between their quantiles; outside the
 * modelled range the nearest run is used (never extrapolated). The API does the
 * same for ?quota_pct= (backend/app/services/scenarios.py).
 */
export function interpolateSteps(runs, pct) {
  const sorted = [...runs].sort((a, b) => a.pct - b.pct);
  if (!sorted.length) return [];
  const p = Math.max(sorted[0].pct, Math.min(sorted[sorted.length - 1].pct, pct));
  const exact = sorted.find((r) => r.pct === p);
  if (exact) return exact.steps;
  const hi = sorted.find((r) => r.pct > p);
  const lo = sorted[sorted.indexOf(hi) - 1];
  const t = (p - lo.pct) / (hi.pct - lo.pct);
  return lo.steps.map((a, i) => {
    const b = hi.steps[i];
    const row = { ...a };
    for (const q of QUANTILES) row[q] = lerp(a[q], b[q], t);
    if (a.quota != null && b.quota != null) row.quota = Math.round(lerp(a.quota, b.quota, t));
    return row;
  });
}

/** "+15% supply", "−5% supply", "As announced" (same wording as the API). */
export function scenarioLabel(pct) {
  return pct === 0 ? "As announced" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}% supply`;
}

/** How a scenario's median compares with the as-announced one, in words (never colour alone). */
export function scenarioDelta(median, baseMedian, pct) {
  if (!pct || median == null || baseMedian == null) return null;
  const diff = median - baseMedian;
  const rel = (diff / baseMedian) * 100;
  const supply = pct > 0 ? "More" : "Less";
  if (Math.abs(rel) < 0.05) {
    return { diff, rel, dir: "flat", text: `${supply} supply than announced barely changes the model's projected premium.` };
  }
  const dir = diff < 0 ? "down" : "up";
  return { diff, rel, dir,
    text: `${supply} supply than announced ${dir === "down" ? "lowers" : "raises"} the model's projected premium.` };
}

// ---------------------------------------------------------------------------
// Probabilities from a forecast step
// ---------------------------------------------------------------------------
// these are the probability levels of those columns so that a step can become a curve
const LEVELS = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95];

/**
 * P(premium <= x) for a forecast step: straight lines between its quantiles,
 * with the outer segments extended to 0 and 1. Mirrors the API's
 * backend/app/services/quantiles.py, so the pages and the server agree.
 */
export function cdfAt(step, x) {
  const v = QUANTILES.map((q) => step[q]);
  const loSlope = (v[1] - v[0]) / (LEVELS[1] - LEVELS[0]) || 1;
  const hiSlope = (v[6] - v[5]) / (LEVELS[6] - LEVELS[5]) || 1;
  const xs = [Math.max(0, v[0] - loSlope * LEVELS[0]), ...v, v[6] + hiSlope * (1 - LEVELS[6])];
  const ps = [0, ...LEVELS, 1];
  if (x <= xs[0]) return 0;
  if (x >= xs[xs.length - 1]) return 1;
  const i = xs.findIndex((k) => k >= x);
  if (xs[i] === xs[i - 1]) return ps[i];
  return ps[i - 1] + ((x - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ps[i] - ps[i - 1]);
}

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------
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

/** A round step for comparing bids: about 1.5% of the expected premium ($2,000 at $133k, $200 at $12k). */
export function bidStep(median) {
  const rough = median * 0.015;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
}

/**
 * Round bids around `bid` with their chance of winning: [{ bid, probability, current }].
 * The current bid is kept exact; its neighbours sit on round numbers.
 */
export function bidLadder(curve, bid, median) {
  const step = bidStep(median);
  const seen = new Set([bid]);
  const rows = [{ bid, probability: winProbability(curve, bid), current: true }];
  for (const k of [-2, -1, 1, 2]) {
    const b = Math.round((bid + k * step) / step) * step;
    if (b <= 0 || seen.has(b)) continue;
    seen.add(b);
    rows.push({ bid: b, probability: winProbability(curve, b), current: false });
  }
  return rows.sort((x, y) => x.bid - y.bid);
}

/**
 * Where a bid sits in the forecast for the next exercise, in one sentence.
 * plan: { expected_premium, q10, q90 }.
 */
export function explainBid(plan, bid, money) {
  const diff = bid - plan.expected_premium;
  const gap = Math.abs(diff) < 50 ? "right at" : `${money(Math.abs(diff))} ${diff > 0 ? "above" : "below"}`;
  const head = `Your bid is ${gap} our median forecast (${money(plan.expected_premium)})`;
  if (bid < plan.q10) {
    return `${head} and below the model's 80% range: the premium would have to come in unusually low for this bid to win.`;
  }
  if (bid > plan.q90) {
    return `${head} and above the model's 80% range: it wins in all but the model's highest outcomes, and you commit to paying up to it if the premium spikes.`;
  }
  return `${head}, inside the model's 80% range (${money(plan.q10)}–${money(plan.q90)}), where the result is hardest to call. A small change in your bid moves your chance a lot here.`;
}

// ---------------------------------------------------------------------------
// Renewal: Prevailing Quota Premium (PQP)
// ---------------------------------------------------------------------------
// this cuts a date to YYYY-MM so that months can be compared as text
const monthKey = (m) => String(m).slice(0, 7);

// this moves a month forward or back so that the PQP window can be built
function addMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Estimated PQP for a month: the average premium of the bidding exercises in the
 * three months before it. Uses recorded results where they exist and the median
 * forecast for exercises that have not happened yet.
 * history: [{ month, bidding_no, premium }], steps: [{ month, bidding_no, q50 }].
 * Returns { month, value, actual, forecast } (counts of each kind), or null if
 * an exercise in the window has neither a result nor a forecast.
 */
export function pqpFor(month, history, steps = []) {
  const target = monthKey(month);
  // this is the three months before the target so that it follows the PQP rule
  const window = [addMonths(target, -3), addMonths(target, -2), addMonths(target, -1)];
  const actual = new Map(history.map((h) => [`${monthKey(h.month)}|${h.bidding_no}`, h.premium]));
  const fc = new Map(steps.map((s) => [`${monthKey(s.month)}|${s.bidding_no}`, s.q50]));
  let sum = 0;
  let nActual = 0;
  let nForecast = 0;
  // this uses the real result if there is one or the forecast if not so that the estimate gets
  // better over time
  for (const m of window) {
    for (const b of [1, 2]) {
      const key = `${m}|${b}`;
      if (actual.has(key)) { sum += actual.get(key); nActual += 1; }
      else if (fc.has(key)) { sum += fc.get(key); nForecast += 1; }
      else return null;
    }
  }
  return { month: target, value: sum / (nActual + nForecast), actual: nActual, forecast: nForecast };
}

/** The current PQP month (the month after the latest result) and the next three, where they can be estimated. */
export function pqpPath(history, steps = []) {
  if (!history.length) return [];
  const last = monthKey(history[history.length - 1].month);
  const complete = history.filter((h) => monthKey(h.month) === last).length >= 2;
  const first = complete ? addMonths(last, 1) : last;
  return [0, 1, 2, 3].map((k) => pqpFor(addMonths(first, k), history, steps)).filter(Boolean);
}
