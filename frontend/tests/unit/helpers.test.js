// Unit tests for the pure front-end helpers (Node's built-in test runner, no dependencies):
//   cd frontend && node --test tests/unit/

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatReply } from "../../public/js/analyst.js";
import { plainEffect } from "../../public/js/pages/policy.js";
import { buildHash, clampQuota, parseHash, scenarioPct } from "../../public/js/route.js";
import { STEPS } from "../../public/js/tour.js";
import { money, moneyShort, number, parseMoney, pct } from "../../public/js/util.js";

test("parseMoney accepts sensible currency formats and normalises them", () => {
  for (const [input, value] of [["100000", 100000], ["100,000", 100000], ["$100,000", 100000], ["$ 95,000.00", 95000],
                                ["S$95,000", 95000], ["95k", 95000], ["12.5K", 12500], [" 88000 ", 88000]]) {
    assert.deepEqual(parseMoney(input), { ok: true, value }, input);
  }
});

test("parseMoney rejects letters, NaN, negatives, zero, blanks and out-of-range values", () => {
  for (const input of ["d", "abc", "NaN", "-200", "0", "", "   ", "1,00,000", "12..5", "$", "1e5", "1000000", null, undefined]) {
    const r = parseMoney(input);
    assert.equal(r.ok, false, String(input));
    assert.match(r.error, /^Enter a COE premium/);
  }
  assert.equal(parseMoney("").empty, true);
  assert.equal(parseMoney("-200").error, "Enter a COE premium above $0.");
});

test("number formatting never shows NaN, undefined or Infinity", () => {
  for (const bad of [NaN, undefined, null, Infinity, -Infinity, "12"]) {
    assert.equal(money(bad), "—");
    assert.equal(moneyShort(bad), "—");
    assert.equal(number(bad), "—");
    assert.equal(pct(bad), "—");
  }
  assert.equal(money(131890.4), "$131,890");
  assert.equal(moneyShort(131890), "$132k");
});

test("hash routes round-trip with categories and query parameters", () => {
  assert.deepEqual(parseHash("#/forecast/A?scenario=quota_plus_10"),
    { path: "forecast/A", page: "forecast", category: "A", query: { scenario: "quota_plus_10" } });
  assert.equal(parseHash("#/").page, "overview");
  assert.equal(parseHash("#/watchlist").page, "alerts");
  assert.equal(buildHash({ page: "bid", category: "A", bid: 125000 }), "#/bid/A?bid=125000");
  assert.equal(buildHash({ page: "forecast", category: "B", scenario: "base" }), "#/forecast/B");
  assert.equal(buildHash({ page: "model", category: "A" }), "#/model");
  assert.equal(buildHash({ page: "nope" }), "#/");
  const h = buildHash({ page: "policy", category: "C", event: "quota_injection_2025" });
  assert.deepEqual(parseHash(h).query, { event: "quota_injection_2025" });
});

test("supply what-ifs route to the Scenario Lab; Learn sections live in the path", () => {
  assert.equal(buildHash({ page: "scenario", category: "A", quota: 12 }), "#/scenario/A?quota=12");
  assert.equal(buildHash({ page: "scenario", category: "A", quota: 0 }), "#/scenario/A");
  assert.equal(buildHash({ page: "scenario", category: "B", scenario: "quota_minus_10" }), "#/scenario/B?quota=-10");
  assert.equal(buildHash({ page: "forecast", category: "A", scenario: "quota_plus_10" }), "#/scenario/A?quota=10");   // old links follow
  assert.deepEqual(["base", "quota_plus_20", "quota_minus_10", "nope", undefined].map(scenarioPct), [0, 20, -10, null, null]);
  assert.deepEqual([12.4, "15", 99, -99, "abc", null].map(clampQuota), [12, 15, 20, -20, 0, 0]);
  assert.equal(buildHash({ page: "learn" }), "#/learn");
  assert.equal(buildHash({ page: "learn", section: "how" }), "#/learn/how");
  assert.equal(buildHash({ page: "model", section: "technical" }), "#/model?section=technical");
  assert.equal(buildHash({ page: "plan", intent: "renew" }), "#/plan?intent=renew");
  assert.equal(parseHash("#/scenario/C?quota=-10").category, "C");
});

test("policy effects read as plain English, including non-significance", () => {
  assert.equal(plainEffect({ category: "A", pct_effect: -10.8, significant: false }, "step"),
    "The model estimates Cat A premiums were about 10.8% lower after this change, but the effect is not statistically significant — it could plausibly be zero.");
  assert.match(plainEffect({ category: "D", pct_effect: 32.9, significant: true }, "temporary"),
    /32\.9% higher while it was in force, and the effect is statistically significant/);
  assert.match(plainEffect({ category: "E", pct_effect: -0.1, significant: false }, "step"), /essentially no change/);
});

test("analyst replies are escaped before formatting", () => {
  assert.equal(formatReply("Hi **there**\n\n- one\n- two"), "<p>Hi <strong>there</strong></p><ul><li>one</li><li>two</li></ul>");
  assert.equal(formatReply("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
});

test("the tour has seven steps, each with a page, an anchor and copy", () => {
  assert.equal(STEPS.length, 7);
  assert.deepEqual(STEPS.map((s) => s.page), ["overview", "forecast", "scenario", "bid", "policy", "model", "alerts"]);
  for (const s of STEPS) assert.ok(s.anchor && s.title && s.body.length > 40);
});
