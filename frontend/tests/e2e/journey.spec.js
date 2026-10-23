// Acceptance 13 (no console errors on the main journey) and 14 (no horizontal
// overflow at phone, tablet and desktop widths), plus routing details.

import { expect, test } from "./fixtures.js";

test("main journey has no console errors", async ({ page, problems }) => {
  await page.goto("/");
  await expect(page.locator("#cards .cat-card")).toHaveCount(5);
  await expect(page.locator("#home-fan svg .series-line")).toHaveCount(2);
  await page.locator("#cards .cat-card").nth(1).click();
  await expect(page.locator("h1")).toContainText("Cat B");
  await page.getByRole("button", { name: "Table view" }).click();
  await page.getByRole("link", { name: "Open the Scenario Lab" }).click();
  await expect(page.locator("#lab-median")).not.toHaveText("—");
  await page.getByRole("button", { name: "−20% supply" }).click();
  await expect(page.locator("#lab-note")).toContainText("Less supply than announced");

  await page.locator('.nav-links a[data-nav="plan"]').click();
  await expect(page.locator("#plan-result")).toContainText("Your COE plan");
  await page.locator('.subnav a[data-sub="bid"]').click();
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);

  await page.locator('.nav-links a[data-nav="explore"]').click();
  await page.locator('.subnav a[data-sub="policy"]').click();
  await page.locator('[data-seg="cat"] button[data-value="A"]').click();
  await expect(page.locator("#hist-sub")).toContainText("Cat A");
  await page.locator(".tech-details summary").first().click();

  await page.locator('.nav-links a[data-nav="learn"]').click();
  await expect(page.locator("h1")).toHaveText("How COE works.");
  await page.locator('.subnav a[data-sub="model"]').click();
  await page.getByText("View technical evaluation").click();
  await expect(page.locator("#by-horizon svg .series-line")).toHaveCount(3);
  await expect(page.locator("#backtest svg .series-line")).toHaveCount(2);
  await page.locator('[data-seg="bt-cat"] button[data-value="D"]').click();

  await page.locator('.nav-links a[data-nav="plan"]').click();
  await page.locator('.subnav a[data-sub="alerts"]').click();
  await expect(page.locator("#alert-form")).toBeVisible();
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: /What the terms mean/ }).click();
  await expect(page.locator("#glossary-dialog")).toContainText("Box-Tiao");
  await page.keyboard.press("Escape");
  expect(problems).toEqual([]);
});

const ROUTES = ["/", "/#/forecast/A", "/#/scenario/A?quota=12", "/#/bid/A", "/#/plan?intent=buy", "/#/plan?intent=renew", "/#/policy/B",
                "/#/model?section=technical", "/#/alerts", "/#/learn", "/#/learn/how", "/#/learn/sources", "/#/learn/faq", "/#/learn/about"];
for (const width of [375, 768, 1024, 1440]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    for (const url of ROUTES) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${url} overflows by ${over}px`).toBeLessThanOrEqual(0);
      await expect(page.locator("#theme-toggle")).toBeInViewport();          // nav buttons stay reachable
      await expect(page.locator("#ask-compass")).toBeInViewport();
    }
  });
}

test("the main navigation has five places and each section shows its pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nav-links a")).toHaveText(["Overview", "Forecast", "Plan", "Explore", "Learn"]);
  await expect(page.locator("#subnav")).toBeHidden();
  await expect(page).toHaveTitle("COE Compass");

  await page.locator('.nav-links a[data-nav="explore"]').click();
  await expect(page).toHaveURL(/#\/scenario\/A$/);
  await expect(page.locator(".subnav a")).toHaveText(["Scenario Lab", "Policy Lab"]);
  await expect(page.locator('.subnav a[aria-current="page"]')).toHaveText("Scenario Lab");
  await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText("Explore");
  await expect(page).toHaveTitle("Scenario Lab · COE Compass");

  // The section tabs keep the category being viewed.
  await page.locator('[data-seg="cat"] button[data-value="C"]').click();
  await expect(page.locator('.subnav a[data-sub="policy"]')).toHaveAttribute("href", "#/policy/C");

  await page.locator('.nav-links a[data-nav="plan"]').click();
  await expect(page.locator(".subnav a")).toHaveText(["My plan", "Bid planner", "Watchlist"]);
  await page.goto("/#/model");
  await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText("Learn");
  await expect(page.locator('.subnav a[aria-current="page"]')).toHaveText("Model performance");
});

test("the market status bar is on every page", async ({ page, request }) => {
  const s = await (await request.get("/api/summary")).json();
  for (const url of ["/", "/#/bid/B", "/#/learn/faq"]) {
    await page.goto(url);
    const bar = page.locator("#statusbar");
    await expect(bar.locator(".status-item")).toHaveCount(5);
    await expect(bar).toContainText(`$${s.categories[0].latest.premium.toLocaleString("en-SG")}`);
    await expect(bar).toContainText(`Next exercise ${s.next_exercise.label}`);
    await expect(bar).toContainText("Forecast updated");
    await expect(bar).toContainText("SGT");
    await expect(bar).toContainText("LTA");
  }
  await page.locator("#statusbar .status-item").nth(3).click();
  await expect(page).toHaveURL(/#\/forecast\/D$/);
});

test("Back restores the scroll position; new navigations start at the top", async ({ page }) => {
  await page.goto("/#/forecast/A");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.getByRole("link", { name: "How accurate is this?" }).click();
  await expect(page.locator("h1")).toHaveText("Honest numbers.");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.goBack();
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
});

test("keyboard: skip link, focusable nav and Escape closes Ask Compass", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.locator("#ask-compass").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#analyst-input")).toBeFocused();
  await expect(page.locator("#ask-compass")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#analyst")).toBeHidden();
  await expect(page.locator("#ask-compass")).toBeFocused();
});

test("the home page starts from what the visitor wants to do", async ({ page, request, problems }) => {
  const s = await (await request.get("/api/summary")).json();
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Make sense of Singapore's COE market.");
  await expect(page.locator("#updated")).toContainText(`${s.data_through.label} bidding exercise included`);
  await expect(page.locator(".intent")).toHaveCount(4);
  const card = page.locator("#cards .cat-card").first();
  await expect(card).toContainText("Next exercise forecast");
  await expect(card).toContainText("likely range");
  await expect(card.locator(".pill")).toHaveText(s.categories[0].signal.label);
  await expect(card.locator(".driver")).toHaveCount(3);
  await expect(page.locator("#cards")).not.toContainText(/Buy now|Lean buy|Lean wait/);
  await expect(page.locator("#home-provenance")).toContainText(`run #${s.run.id}`);
  await expect(page.locator(".pipeline .step")).toHaveCount(5);

  // The chart changes category in place.
  const svg = await page.locator("#home-fan svg").elementHandle();
  await page.locator('[data-seg="home-cat"] button[data-value="D"]').click();
  await expect(page.locator("#home-chart-sub")).toContainText("Cat D");
  await expect(page.locator("#home-forecast-link")).toHaveAttribute("href", "#/forecast/D");
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);

  await page.getByRole("link", { name: "Renewing my COE" }).click();
  await expect(page).toHaveURL(/#\/plan\?intent=renew/);
  await expect(page.locator("#plan-result")).toContainText("Your renewal outlook");
  expect(problems).toEqual([]);
});
