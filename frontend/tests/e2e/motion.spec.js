// Motion design: changes happen in place (no re-render), values settle on the
// right numbers after interpolating, and reduced motion keeps every result.

import { expect, test } from "./fixtures.js";

const money = (v) => `$${Math.round(v).toLocaleString("en-SG")}`;

test("switching category updates the Forecast in place and never mixes categories", async ({ page, request, problems }) => {
  const c = await (await request.get("/api/forecast/C?scenario=base")).json();
  await page.goto("/#/forecast/A");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  const svg = await page.locator("#fan svg").elementHandle();
  const view = await page.locator("#app .view").elementHandle();

  // Rapid A -> B -> C -> D -> C: the newest choice wins, and everything settles on Cat C.
  for (const cat of ["B", "C", "D", "C"]) await page.locator(`[data-seg="cat"] button[data-value="${cat}"]`).click();
  await expect(page.locator("h1")).toContainText("Cat C");
  await expect(page.locator("#fig-latest")).toHaveText(money(c.origin.premium));
  await expect(page.locator("#fig-median")).toHaveText(money(c.steps[5].q50));
  await expect(page.locator("#steps tbody tr").nth(5)).toContainText(money(c.steps[5].q50));
  await expect(page.locator("#advice .advice-for")).toHaveText("Our read for Cat C");

  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);     // chart morphed, not rebuilt
  expect(await view.evaluate((el) => el.isConnected)).toBe(true);    // page not re-rendered
  await expect(page.locator('[data-seg="cat"] .seg-thumb')).toHaveCount(1);

  // Back goes to the previous category, still in place.
  await page.goBack();
  await expect(page).toHaveURL(/#\/forecast\/D/);
  await expect(page.locator("h1")).toContainText("Cat D");
  expect(await view.evaluate((el) => el.isConnected)).toBe(true);
  await expect(page.locator('[data-seg="cat"] button[data-value="D"]')).toHaveAttribute("aria-pressed", "true");
  expect(problems).toEqual([]);
});

test("a supply scenario states its effect in words next to the median", async ({ page, request }) => {
  const [base, plus] = await Promise.all(["base", "quota_plus_20"].map(async (s) =>
    (await request.get(`/api/forecast/A?scenario=${s}`)).json()));
  const diff = plus.steps[5].q50 - base.steps[5].q50;
  await page.goto("/#/forecast/A");
  await expect(page.locator("#fig-delta")).toContainText("Supply as announced");
  await expect(page.locator("#fig-note")).toBeHidden();

  await page.getByRole("button", { name: "+20% supply" }).click();
  await expect(page.locator("#fig-median")).toHaveText(money(plus.steps[5].q50));
  await expect(page.locator("#fig-delta")).toContainText(money(Math.abs(diff)));
  await expect(page.locator("#fig-delta")).toContainText(diff < 0 ? "lower than as announced" : "higher than as announced");
  await expect(page.locator("#fig-note")).toContainText("More supply than announced");

  await page.getByRole("button", { name: "As announced" }).click();
  await expect(page.locator("#fig-median")).toHaveText(money(base.steps[5].q50));
  await expect(page.locator("#fig-note")).toBeHidden();
});

test("the forecast chart zooms with Ctrl + scroll (not the page) and zooms back", async ({ page, problems }) => {
  await page.goto("/#/forecast/A");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await page.locator('[data-seg="range"] button[data-value="0"]').click();
  const fan = page.locator("#fan");
  const reset = page.getByRole("button", { name: "Reset zoom" });
  const xLabels = () => page.locator("#fan svg text[text-anchor='middle']").allTextContents();
  await expect(reset).toBeDisabled();
  await expect.poll(async () => (await xLabels()).includes("2014")).toBe(true);    // whole history
  const ratio = await page.evaluate(() => window.devicePixelRatio);

  const box = await page.locator("#fan svg").boundingBox();
  await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2);           // over the forecast
  await page.keyboard.down("Control");
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect(fan).toHaveClass(/is-zoomed/);
  await expect(reset).toBeEnabled();
  await expect.poll(async () => (await xLabels()).includes("2014")).toBe(false);   // zoomed into recent months
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(ratio);            // the page itself did not zoom

  // A scenario keeps the zoom (compare in place); a history range is a new window.
  await page.getByRole("button", { name: "+10% supply" }).click();
  await expect(page.locator("#steps-sub")).toContainText("+10% supply");
  await expect(fan).toHaveClass(/is-zoomed/);
  await reset.click();
  await expect(fan).not.toHaveClass(/is-zoomed/);
  await page.getByRole("button", { name: "Zoom to forecast" }).click();
  await expect(fan).toHaveClass(/is-zoomed/);
  await page.locator('[data-seg="range"] button[data-value="3"]').click();
  await expect(fan).not.toHaveClass(/is-zoomed/);

  // The "Latest" label is never cut off at the chart's edge.
  const fits = await page.locator("#fan svg").evaluate((svg) => {
    const t = [...svg.querySelectorAll("text.marker-label")].find((el) => el.textContent === "Latest");
    const b = t.getBBox();
    return b.x >= 0 && b.x + b.width <= svg.viewBox.baseVal.width;
  });
  expect(fits).toBe(true);
  expect(problems).toEqual([]);
});

test("Overview card opens its forecast with the same figures (shared transition)", async ({ page, problems }) => {
  await page.goto("/");
  const card = page.locator("#cards .cat-card").nth(1);
  const premium = await card.locator(".big-number").innerText();
  const median = await card.locator(".cat-median").innerText();
  await card.hover();                                      // warms the forecast's data
  await card.click();
  await expect(page).toHaveURL(/#\/forecast\/B$/);
  await expect(page.locator("h1")).toContainText("Cat B");
  await expect(page.locator("#fig-latest")).toHaveText(premium);
  await expect(page.locator("#fig-median")).toHaveText(median);
  await expect(page.locator("html")).not.toHaveClass(/vt-category/);    // transition cleaned up
  expect(await page.evaluate(() => document.querySelectorAll("[style*='view-transition-name']").length)).toBe(0);
  expect(problems).toEqual([]);
});

test("Bid planner changes category in place and the marker follows the bid", async ({ page, request }) => {
  const e = await (await request.get("/api/bid-planner/E")).json();
  await page.goto("/#/bid/A");
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);
  const svg = await page.locator("#cdf svg").elementHandle();
  await page.locator('[data-seg="cat"] button[data-value="E"]').click();
  await expect(page.locator("#bid-eyebrow")).toContainText("Cat E");
  await expect(page.locator("#bid-input")).toHaveValue(Math.round(e.bid).toLocaleString("en-SG"));
  await expect(page.locator("#bid-expected")).toHaveText(money(e.expected_premium));
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);

  // The marker and its reading guides sit on the bid once the glide settles.
  const top = e.suggestions[e.suggestions.length - 1];
  await page.locator("[data-bid]").last().click();
  await expect(page.locator("#prob")).toHaveText(/^(\d+|>99)%$/);
  await expect(page.locator("#cdf svg .pts line.guide")).toHaveCount(2);
  await expect(page.locator("#bid-input")).toHaveValue(Math.round(top.bid).toLocaleString("en-SG"));
});

test("Policy Lab: choosing an event shows it on the chart with its impact in words", async ({ page }) => {
  await page.goto("/#/policy/B");
  const chip = page.locator("#event-picker [data-pick]").first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#policy-focus")).toBeVisible();
  await expect(page.locator("#policy-focus")).toContainText(/Cat B premiums|did not apply|Not enough data/);
  await expect(page.locator("#policy-focus")).toContainText("Shaded on the chart");
  await expect(page.locator("#history svg .marker-line.is-active")).toHaveCount(1);
  await expect(page.locator("#history svg rect.region")).toHaveCount(1);
  await expect(page).toHaveURL(/event=/);

  // The same event from its card; choosing it again clears the selection.
  await chip.click();
  await expect(page.locator("#policy-focus")).toBeHidden();
  await expect(page.locator("#history svg rect.region")).toHaveCount(0);
  const show = page.locator("[data-show-event]").first();
  await show.click();
  await expect(show).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#policy-focus")).toBeVisible();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("every change still lands, immediately and with the right values", async ({ page, request, problems }) => {
    const plus = await (await request.get("/api/forecast/B?scenario=quota_minus_20")).json();
    await page.goto("/#/forecast/B");
    await expect(page.locator("#steps tbody tr")).toHaveCount(6);
    await page.getByRole("button", { name: "−20% supply" }).click();
    await expect(page.locator("#fig-median")).toHaveText(money(plus.steps[5].q50));
    await expect(page.locator("#fig-note")).toContainText("Less supply than announced");
    // The selection indicator moves without a sliding transition.
    const transition = await page.locator('[data-seg="scenario"] .seg-thumb').evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(transition).not.toMatch(/transform/);

    await page.goto("/");
    await page.locator("#cards .cat-card").first().click();
    await expect(page.locator("h1")).toContainText("Cat A");
    await expect(page.locator("#fig-latest")).not.toHaveText("—");
    expect(problems).toEqual([]);
  });
});
