// Unit tests for the pure parts of the motion work: chart morph resampling,
// the scenario comparison wording, bid probabilities and policy periods.
//   cd frontend && node --test tests/unit/

import assert from "node:assert/strict";
import { test } from "node:test";

import { mixPts, sample } from "../../public/js/charts.js";
import { DURATION, EASE_FN } from "../../public/js/motion.js";
import { winProbability } from "../../public/js/pages/bid.js";
import { scenarioDelta } from "../../public/js/pages/forecast.js";
import { eventPeriod } from "../../public/js/pages/policy.js";

test("sample interpolates inside a series and returns null outside it", () => {
  const pts = [[0, 10], [10, 20], [20, 40]];
  assert.deepEqual(sample(pts, 5), [15]);
  assert.deepEqual(sample(pts, 20), [40]);
  assert.equal(sample(pts, -1), null);
  assert.equal(sample(pts, 21), null);
});

test("mixPts morphs matching x grids point by point", () => {
  const a = [[0, 100], [1, 200]];
  const b = [[0, 300], [1, 100]];
  assert.deepEqual(mixPts(a, b, 0), a);
  assert.deepEqual(mixPts(a, b, 1), b);
  assert.deepEqual(mixPts(a, b, 0.5), [[0, 200], [1, 150]]);
});

test("mixPts on different grids keeps points one side lacks at their own value", () => {
  // A longer history (b) than before (a): the extra old points do not move while the domain widens.
  const a = [[10, 1], [20, 2]];
  const b = [[0, 5], [10, 1], [20, 2]];
  assert.deepEqual(mixPts(a, b, 0.5), [[0, 5], [10, 1], [20, 2]]);
  // Bands carry two values per point.
  assert.deepEqual(mixPts([[0, 1, 3]], [[0, 3, 7]], 0.5), [[0, 2, 5]]);
});

test("scenario comparison is worded, not colour-only", () => {
  assert.equal(scenarioDelta(100, 100, "base"), null);
  const lower = scenarioDelta(95_000, 100_000, "quota_plus_20");
  assert.equal(lower.dir, "down");
  assert.equal(lower.diff, -5000);
  assert.match(lower.text, /More supply than announced lowers/);
  const higher = scenarioDelta(104_000, 100_000, "quota_minus_10");
  assert.equal(higher.dir, "up");
  assert.match(higher.text, /Less supply than announced raises/);
  assert.equal(scenarioDelta(100_100, 100_000, "quota_plus_10").dir, "flat");
});

test("win probability interpolates the curve and clamps at its ends", () => {
  const curve = [{ bid: 100, probability_pct: 10 }, { bid: 200, probability_pct: 90 }];
  assert.equal(winProbability(curve, 50), 0);
  assert.equal(winProbability(curve, 150), 50);
  assert.equal(winProbability(curve, 250), 100);
  assert.equal(winProbability([], 150), 0);
});

test("policy periods: temporary events use their end date, others a fixed window", () => {
  const temp = eventPeriod({ kind: "temporary", effective_month: "2020-06-01", end_month: "2021-06-01" });
  assert.equal(temp.x1.toISOString().slice(0, 7), "2021-06");
  assert.match(temp.text, /in force/);
  const step = eventPeriod({ kind: "step", effective_month: "2023-08-01", end_month: null });
  assert.equal(step.x1.toISOString().slice(0, 7), "2024-08");
  assert.match(step.text, /12 months/);
  assert.match(eventPeriod({ kind: "pulse", effective_month: "2020-01-01" }).text, /3 months/);
});

test("motion tokens stay in the calm range and easings end where they should", () => {
  for (const ms of Object.values(DURATION)) assert.ok(ms >= 120 && ms <= 350, `${ms}ms`);
  for (const ease of Object.values(EASE_FN)) {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
  }
});
