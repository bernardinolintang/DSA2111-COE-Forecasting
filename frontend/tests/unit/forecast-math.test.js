// Unit tests for the forecast arithmetic behind the Scenario Lab, the Bid planner and My plan:
//   cd frontend && node --test tests/unit/

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bidLadder, bidStep, cdfAt, explainBid, interpolateSteps, pqpFor, pqpPath, scenarioDelta, scenarioLabel, winProbability,
} from "../../public/js/forecast-math.js";
import { driverText, forecastId, money, sgt } from "../../public/js/util.js";

const QS = ["q05", "q10", "q25", "q50", "q75", "q90", "q95"];
const SPREAD = [0.8, 0.85, 0.92, 1, 1.08, 1.15, 1.2];
const step = (median, extra = {}) => ({ ...Object.fromEntries(QS.map((q, i) => [q, median * SPREAD[i]])), ...extra });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

test("the slider interpolates between modelled runs and never extrapolates", () => {
  const runs = [
    { pct: 20, steps: [step(100_000, { quota: 1000 }), step(96_000, { quota: 1200 })] },
    { pct: 0, steps: [step(100_000, { quota: 1000 }), step(100_000, { quota: 1000 })] },
    { pct: 10, steps: [step(100_000, { quota: 1000 }), step(98_000, { quota: 1100 })] },
  ];
  assert.equal(interpolateSteps(runs, 10), runs[2].steps);                 // a modelled point is used as is
  const mid = interpolateSteps(runs, 15)[1];
  near(mid.q50, 97_000);
  near(mid.q10, 97_000 * 0.85);
  assert.equal(mid.quota, 1150);
  near(interpolateSteps(runs, 5)[1].q50, 99_000);
  assert.equal(interpolateSteps(runs, 40), runs[0].steps);                 // clamped to the modelled range
  assert.equal(interpolateSteps(runs, -5), runs[1].steps);
  assert.deepEqual(interpolateSteps([], 5), []);
});

test("scenario wording: labels and the comparison with the forecast as announced", () => {
  assert.deepEqual([scenarioLabel(0), scenarioLabel(15), scenarioLabel(-5)], ["As announced", "+15% supply", "−5% supply"]);
  assert.equal(scenarioDelta(100, 100, 0), null);
  const more = scenarioDelta(98_000, 100_000, 20);
  assert.equal(more.dir, "down");
  assert.equal(more.text, "More supply than announced lowers the model's projected premium.");
  near(more.rel, -2);
  assert.equal(scenarioDelta(101_000, 100_000, -20).text, "Less supply than announced raises the model's projected premium.");
  assert.equal(scenarioDelta(100_010, 100_000, 5).dir, "flat");
});

test("cdfAt matches the API's quantile maths", () => {
  const s = step(100_000);                                                 // quantiles 80k … 120k
  [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95].forEach((level, i) => near(cdfAt(s, s[QS[i]]), level));
  assert.equal(cdfAt(s, 0), 0);
  assert.equal(cdfAt(s, 500_000), 1);
  near(cdfAt(s, 96_000), 0.375);                                           // half-way between p25 and p50
  let last = 0;
  for (let x = 70_000; x <= 130_000; x += 2_500) { const p = cdfAt(s, x); assert.ok(p >= last); last = p; }
});

test("bid planner: chance of winning, nearby bids and the explanation", () => {
  const curve = [{ bid: 100_000, probability_pct: 0 }, { bid: 110_000, probability_pct: 50 }, { bid: 120_000, probability_pct: 100 }];
  assert.equal(winProbability(curve, 90_000), 0);
  assert.equal(winProbability(curve, 105_000), 25);
  assert.equal(winProbability(curve, 130_000), 100);
  assert.equal(winProbability([], 1), 0);
  assert.deepEqual([bidStep(133_000), bidStep(92_000), bidStep(12_200)], [2000, 1000, 200]);

  const ladder = bidLadder(curve, 110_700, 110_000);
  assert.deepEqual(ladder.map((r) => r.bid), [106_000, 108_000, 110_700, 112_000, 114_000]);
  assert.equal(ladder.filter((r) => r.current).length, 1);
  assert.ok(ladder.every((r, i) => i === 0 || r.probability >= ladder[i - 1].probability));

  const plan = { expected_premium: 133_217, q10: 125_845, q90: 141_860 };
  assert.match(explainBid(plan, 136_017, money), /^Your bid is \$2,800 above our median forecast \(\$133,217\), inside the model's 80% range/);
  assert.match(explainBid(plan, 120_000, money), /below our median forecast.*below the model's 80% range/);
  assert.match(explainBid(plan, 150_000, money), /above the model's 80% range/);
  assert.match(explainBid(plan, 133_217, money), /^Your bid is right at our median forecast/);
});

test("PQP: the average of the three months before, with forecasts for exercises not yet held", () => {
  const history = [];
  for (const [month, a, b] of [["2026-06-01", 100, 102], ["2026-07-01", 104, 106], ["2026-08-01", 108, 110], ["2026-09-01", 112, 114]]) {
    history.push({ month, bidding_no: 1, premium: a }, { month, bidding_no: 2, premium: b });
  }
  const steps = [["2026-10-01", 1, 120], ["2026-10-01", 2, 122], ["2026-11-01", 1, 124], ["2026-11-01", 2, 126],
                 ["2026-12-01", 1, 128], ["2026-12-01", 2, 130]].map(([month, bidding_no, q50]) => ({ month, bidding_no, q50 }));

  assert.deepEqual(pqpFor("2026-10-01", history, steps), { month: "2026-10", value: 109, actual: 6, forecast: 0 });   // Jul–Sep
  const nov = pqpFor("2026-11", history, steps);                            // Aug, Sep recorded + Oct forecast
  assert.deepEqual([nov.actual, nov.forecast], [4, 2]);
  near(nov.value, (108 + 110 + 112 + 114 + 120 + 122) / 6);
  assert.equal(pqpFor("2027-03", history, steps), null);                    // beyond the forecast
  assert.equal(pqpFor("2026-08", history.slice(2), steps), null);           // May is missing

  const path = pqpPath(history, steps);
  assert.deepEqual(path.map((p) => p.month), ["2026-10", "2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(path.map((p) => p.forecast), [0, 2, 4, 6]);
  assert.equal(pqpPath([], steps).length, 0);
  // a month with only its first exercise so far is still the current month
  assert.equal(pqpPath([...history, { month: "2026-10-01", bidding_no: 1, premium: 118 }], steps)[0].month, "2026-10");
});

test("forecast details: IDs, Singapore time and drivers in words", () => {
  assert.equal(forecastId("A", { month: "2026-10-01", bidding_no: 1 }, { id: 39 }), "A-2026-10-E1-r39");
  assert.equal(forecastId("A", null, { id: 39 }), null);
  assert.equal(sgt("2026-09-30T15:09:29Z"), "30 Sep 2026, 23:09 SGT");
  assert.equal(sgt("2026-09-30T15:09:29Z", { year: false }), "30 Sep, 23:09 SGT");
  assert.equal(sgt(null), "—");
  assert.equal(driverText({ key: "quota", trend: "down", value: -5.9 }), "Quota down 6% on a year ago");
  assert.equal(driverText({ key: "demand", trend: "up", value: 1.6 }), "Demand above its 1-year average");
  assert.equal(driverText({ key: "uncertainty", trend: "moderate", value: 13 }), "Moderate uncertainty");
});
