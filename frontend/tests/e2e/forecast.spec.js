// Acceptance 1 (every category loads), 3 (no stale data on changes), plus the
// scenario race and theme switching without a re-render.

import { expect, test } from "./fixtures.js";

for (const cat of ["A", "B", "C", "D", "E"]) {
  test(`forecast Cat ${cat} loads chart, advice and table`, async ({ page, problems }) => {
    await page.goto(`/#/forecast/${cat}`);
    await expect(page.locator("h1")).toContainText(`Cat ${cat}`);
    await expect(page.locator("#fan svg .series-line")).toHaveCount(2);
    await expect(page.locator("#advice .advice-action")).toHaveText(/Buy now|Lean buy|Wait|Lean wait/);
    await expect(page.locator("#advice .conv-chip")).toHaveText(/conviction/);
    await expect(page.locator("#steps tbody tr")).toHaveCount(6);
    await expect(page.locator("#app")).not.toContainText(/NaN|undefined|Infinity/);
    expect(problems).toEqual([]);
  });
}

test("a slow older scenario response never overwrites a newer one", async ({ page, request }) => {
  // Make "+10%" slow, then click "+10%" and immediately "+20%".
  await page.route("**/api/forecast/A?scenario=quota_plus_10", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/#/forecast/A");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: "+10% supply" }).click();
  await page.getByRole("button", { name: "+20% supply" }).click();
  await page.waitForTimeout(2200);                 // let the slow +10% response arrive last

  const plus20 = await (await request.get("/api/forecast/A?scenario=quota_plus_20")).json();
  const median = `$${Math.round(plus20.steps[5].q50).toLocaleString("en-SG")}`;
  await expect(page.locator("#steps-sub")).toContainText("+20% supply");
  await expect(page.locator("#steps tbody tr").nth(5)).toContainText(median);
  await expect(page.getByRole("button", { name: "+20% supply" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/scenario=quota_plus_20/);
});

test("scenario is kept when switching category, and survives reload", async ({ page }) => {
  await page.goto("/#/forecast/A?scenario=quota_minus_10");
  await expect(page.getByRole("button", { name: "−10% supply" })).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-seg="cat"] button[data-value="C"]').click();
  await expect(page).toHaveURL(/#\/forecast\/C\?scenario=quota_minus_10/);
  await expect(page.locator("h1")).toContainText("Cat C");
  await expect(page.locator("#steps-sub")).toContainText("−10% supply");
});

test("switching theme keeps page state (no re-render)", async ({ page }) => {
  await page.goto("/#/forecast/B");
  await page.getByRole("button", { name: "+20% supply" }).click();
  await expect(page.locator("#steps-sub")).toContainText("+20% supply");
  const svg = await page.locator("#fan svg").elementHandle();
  await page.locator("#theme-toggle").click();
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);
  await expect(page.getByRole("button", { name: "+20% supply" })).toHaveAttribute("aria-pressed", "true");
});
