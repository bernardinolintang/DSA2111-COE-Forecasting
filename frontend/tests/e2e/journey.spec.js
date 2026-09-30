// Acceptance 13 (no console errors on the main journey) and 14 (no horizontal
// overflow at phone, tablet and desktop widths), plus routing details.

import { expect, test } from "./fixtures.js";

test("main journey has no console errors", async ({ page, problems }) => {
  await page.goto("/");
  await expect(page.locator("#cards .cat-card")).toHaveCount(5);
  await page.locator("#cards .cat-card").nth(1).click();
  await expect(page.locator("h1")).toContainText("Cat B");
  await page.getByRole("button", { name: "−20% supply" }).click();
  await page.getByRole("button", { name: "Table view" }).click();
  await page.getByRole("link", { name: "Plan your bid" }).click();
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);
  await page.locator('a[data-nav="policy"]').click();
  await page.locator('[data-seg="cat"] button[data-value="A"]').click();
  await expect(page.locator("#hist-sub")).toContainText("Cat A");
  await page.locator(".tech-details summary").first().click();
  await page.locator('a[data-nav="model"]').click();
  await page.getByText("View technical evaluation").click();
  await expect(page.locator("#by-horizon svg .series-line")).toHaveCount(3);
  await expect(page.locator("#backtest svg .series-line")).toHaveCount(2);
  await page.locator('[data-seg="bt-cat"] button[data-value="D"]').click();
  await page.locator('a[data-nav="alerts"]').click();
  await expect(page.locator("#alert-form")).toBeVisible();
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: /What the terms mean/ }).click();
  await expect(page.locator("#glossary-dialog")).toContainText("Box-Tiao");
  await page.keyboard.press("Escape");
  expect(problems).toEqual([]);
});

const ROUTES = ["/", "/#/forecast/A", "/#/bid/A", "/#/policy/B", "/#/model?section=technical", "/#/alerts"];
for (const width of [375, 768, 1024, 1440]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const url of ROUTES) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${url} overflows by ${over}px`).toBeLessThanOrEqual(0);
      await expect(page.locator("#theme-toggle")).toBeInViewport();          // nav buttons stay reachable
    }
  });
}

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

test("keyboard: skip link, focusable nav and Escape closes the analyst", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByRole("button", { name: "Ask COE Analyst" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#analyst-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#analyst")).toBeHidden();
  await expect(page.getByRole("button", { name: "Ask COE Analyst" })).toBeFocused();
});
