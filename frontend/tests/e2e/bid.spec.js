// Acceptance 2 (chance chart renders on first load), 3 (category change) and
// 4 (slider / input / chart stay in sync).

import { expect, test } from "./fixtures.js";

// Records, at the very moment the chart's <svg> is inserted into #cdf, whether
// it already has the probability curve. With the old code the SVG was inserted
// empty and drawn one or two frames later (the blank chart in the recording).
async function watchFirstPaint(page) {
  await page.addInitScript(() => {
    window.__cdf = null;
    new MutationObserver(() => {
      const svg = document.querySelector("#cdf svg");
      if (svg && window.__cdf === null) window.__cdf = Boolean(svg.querySelector(".series-line"));
    }).observe(document, { childList: true, subtree: true });
  });
}

for (const cat of ["A", "B", "C", "D", "E"]) {
  test(`Cat ${cat}: chance chart is drawn in the same frame it is inserted`, async ({ page, problems }) => {
    await watchFirstPaint(page);
    await page.goto(`/#/bid/${cat}`);
    await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);
    expect(await page.evaluate(() => window.__cdf)).toBe(true);
    await expect(page.locator("#cdf svg :not(.hover) > circle.hover-dot").first()).toBeVisible();
    expect(problems).toEqual([]);
  });
}

test("chart is drawn on first visit when navigating from another page", async ({ page }) => {
  await watchFirstPaint(page);
  await page.goto("/#/forecast/A");
  await expect(page.locator("#fan svg .series-line")).toHaveCount(2);
  await page.locator('a[data-nav="bid"]').click();
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);
  expect(await page.evaluate(() => window.__cdf)).toBe(true);
});

test("slider, typed input, probability and chart marker stay synchronised", async ({ page, request }) => {
  const plan = await (await request.get("/api/bid-planner/A")).json();
  await page.goto("/#/bid/A");
  const svg = await page.locator("#cdf svg").elementHandle();
  const marker = () => page.locator("#cdf svg :not(.hover) > circle.hover-dot").first().getAttribute("cx");

  // Slider
  const before = await marker();
  const target = Math.round(plan.suggestions.find((s) => s.confidence_pct === 90).bid / 100) * 100;
  await page.locator("#bid-range").evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, target);
  await expect(page.locator("#bid-input")).toHaveValue(target.toLocaleString("en-SG"));
  await expect(page.locator("#prob")).toHaveText(/^(8[5-9]|9[0-5])%$/);
  expect(await marker()).not.toBe(before);

  // Typing (with $ and commas) updates everything live
  await page.locator("#bid-input").fill("");
  await page.locator("#bid-input").pressSequentially(`$${plan.suggestions[0].bid.toFixed(0)}`);
  await expect(page.locator("#prob")).toHaveText(/^(4[5-9]|5[0-5])%$/);
  await expect(page.locator("#prob-text")).toContainText(plan.exercise.label);

  // Invalid input shows an error and leaves the last valid state
  await page.locator("#bid-input").fill("abc");
  await expect(page.locator("#bid-error")).toBeVisible();
  await expect(page.locator("#bid-input")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#prob")).not.toHaveText(/NaN/);

  // Suggested bid chip
  await page.locator("[data-bid]").last().click();
  await expect(page.locator("#bid-error")).toBeHidden();
  await expect(page.locator("#prob")).toHaveText(/^(9[0-9]|>99)%$/);

  // The chart was updated in place the whole time, never recreated
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);
  await expect(page).toHaveURL(/#\/bid\/A\?bid=\d+/);
});

test("changing category replaces every value (no stale Cat A numbers)", async ({ page, request }) => {
  const d = await (await request.get("/api/bid-planner/D")).json();
  await page.goto("/#/bid/A");
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);
  await page.locator('[data-seg="cat"] button[data-value="D"]').click();
  await expect(page.locator(".card .eyebrow").first()).toContainText("Cat D");
  await expect(page.locator("#bid-input")).toHaveValue(Math.round(d.bid).toLocaleString("en-SG"));
  await expect(page.locator("#prob-text")).toContainText(d.exercise.label);
  const median = `$${Math.round(d.expected_premium).toLocaleString("en-SG")}`;
  await expect(page.locator("#planner")).toContainText(median);
});

test("a ?bid= link opens the planner at that bid", async ({ page }) => {
  await page.goto("/#/bid/B?bid=150000");
  await expect(page.locator("#bid-input")).toHaveValue("150,000");
});
