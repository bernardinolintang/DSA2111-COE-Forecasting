// Acceptance 1 (every category loads), 3 (no stale data on changes), the market
// outlook (never a buy / wait call), forecast details, and what the page shows
// when the forecast is unavailable.

import { expect, test } from "./fixtures.js";

const money = (v) => `$${Math.round(v).toLocaleString("en-SG")}`;

for (const cat of ["A", "B", "C", "D", "E"]) {
  test(`forecast Cat ${cat} loads chart, outlook and table`, async ({ page, problems }) => {
    await page.goto(`/#/forecast/${cat}`);
    await expect(page.locator("h1")).toContainText(`Cat ${cat}`);
    await expect(page.locator("#fan svg .series-line")).toHaveCount(2);
    await expect(page.locator("#fan svg .series-line[stroke-dasharray]")).toHaveCount(1);     // the forecast is dashed
    await expect(page.locator("#advice .outlook-label")).toHaveText(/pressure|No clear direction/);
    await expect(page.locator("#advice .indicators")).toContainText("Model uncertainty");
    await expect(page.locator("#advice .reasons li")).toHaveCount(3);
    await expect(page.locator("#steps tbody tr")).toHaveCount(6);
    await expect(page.locator("#app")).not.toContainText(/NaN|undefined|Infinity/);
    await expect(page.locator("#app")).not.toContainText(/Buy now|Lean buy|Lean wait|conviction/i);
    expect(problems).toEqual([]);
  });
}

test("the outlook shows its evidence and says it is not advice", async ({ page, request }) => {
  const rec = await (await request.get("/api/recommendation/A")).json();
  await page.goto("/#/forecast/A");
  const card = page.locator("#advice");
  await expect(card.locator(".advice-for")).toHaveText("Market outlook for Cat A");
  await expect(card.locator(".outlook-label")).toHaveText(rec.label);
  await expect(card.locator(".outlook-summary")).toHaveText(rec.summary);
  await expect(card.locator(".indicators")).toContainText("Forecast direction");
  await expect(card.locator(".indicators")).toContainText("Quota");
  await expect(card.locator(".indicators")).toContainText("Demand");
  await expect(card).toContainText(`Chance of a drop of ${Math.round(rec.threshold_pct)}% or more`);
  await expect(card.locator('[data-prob="drop"] .prob-value')).toHaveText(`${Math.round(rec.prob_drop_pct)}%`);
  await expect(card).toContainText("not advice to buy or to wait");
  await expect(page.locator("#fig-signal .pill")).toHaveText(rec.label);
});

test("every forecast shows when it was made, from what, and by which model run", async ({ page, request }) => {
  const f = await (await request.get("/api/forecast/A")).json();
  await page.goto("/#/forecast/A");
  const p = page.locator("#fc-provenance");
  await expect(p).toContainText("Last updated");
  await expect(p).toContainText("SGT");
  await expect(p).toContainText(f.origin.label);
  await expect(p).toContainText(`run #${f.run.id}`);
  await expect(p).toContainText(`A-${f.steps[0].month.slice(0, 7)}-E${f.steps[0].bidding_no}-r${f.run.id}`);
  await p.getByRole("link", { name: "View data sources" }).click();
  await expect(page).toHaveURL(/#\/learn\/sources$/);
  await expect(page.locator("h1")).toHaveText("Where the data comes from.");
});

test("key figures: next exercise and end of quarter, each with its likely range", async ({ page, request }) => {
  const f = await (await request.get("/api/forecast/B")).json();
  await page.goto("/#/forecast/B");
  await expect(page.locator("#fig-latest")).toHaveText(money(f.origin.premium));
  await expect(page.locator("#fig-median")).toHaveText(money(f.steps[0].q50));
  await expect(page.locator("#fig-median-label")).toHaveText(f.steps[0].label);
  await expect(page.locator("#fig-horizon")).toHaveText(money(f.steps[5].q50));
  await expect(page.locator("#fig-horizon-label")).toHaveText(f.steps[5].label);
  await expect(page.locator("#fig-next-range")).toHaveText(/^\$\d+k–\$\d+k$/);
});

test("a slow older category response never overwrites a newer one", async ({ page, request }) => {
  // Make Cat B slow, then click B and immediately C.
  await page.route("**/api/forecast/B?scenario=base", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/#/forecast/A");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await page.locator('[data-seg="cat"] button[data-value="B"]').click();
  await page.locator('[data-seg="cat"] button[data-value="C"]').click();
  await page.waitForTimeout(2200);                 // let the slow Cat B response arrive last

  const c = await (await request.get("/api/forecast/C")).json();
  await expect(page.locator("h1")).toContainText("Cat C");
  await expect(page.locator("#fig-median")).toHaveText(money(c.steps[0].q50));
  await expect(page.locator("#steps tbody tr").nth(5)).toContainText(money(c.steps[5].q50));
  await expect(page).toHaveURL(/#\/forecast\/C$/);
});

test("if the forecast is unavailable the page keeps the history and says so", async ({ page }) => {
  await page.route("**/api/forecast/A?scenario=base", (route) => route.fulfill({ status: 503, json: { detail: "No forecasts yet: the ML pipeline has not finished a run." } }));
  await page.route("**/api/recommendation/A?scenario=base", (route) => route.fulfill({ status: 503, json: { detail: "No forecasts yet." } }));
  await page.goto("/#/forecast/A");
  const notice = page.locator("#fc-notice");
  await expect(notice).toContainText("Latest forecast temporarily unavailable");
  await expect(notice).toContainText("Recorded COE results remain available");
  await expect(notice).toContainText("Last successful update");
  await expect(page.locator("#fan svg .series-line")).toHaveCount(1);          // history only, not a blank chart
  await expect(page.locator("#fig-latest")).toHaveText(/^\$[\d,]+$/);
  await expect(page.locator("#advice")).toContainText("No outlook right now");
  await expect(page.locator("#pressure svg")).toBeVisible();                   // the rest of the page still works

  // The service comes back: Try again restores the forecast.
  await page.unroute("**/api/forecast/A?scenario=base");
  await page.unroute("**/api/recommendation/A?scenario=base");
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#fan svg .series-line")).toHaveCount(2);
  await expect(page.locator("#fc-notice")).toBeEmpty();
  await expect(page.locator("#advice .outlook-label")).toBeVisible();
});

test("old supply-scenario links open the Scenario Lab", async ({ page }) => {
  await page.goto("/#/forecast/B?scenario=quota_plus_10");
  await expect(page).toHaveURL(/#\/scenario\/B\?quota=10$/);
  await expect(page.locator("#quota-out")).toHaveText("+10%");
});

test("switching theme keeps page state (no re-render)", async ({ page }) => {
  await page.goto("/#/scenario/B");
  await page.getByRole("button", { name: "+20% supply" }).click();
  await expect(page.locator("#quota-out")).toHaveText("+20%");
  const svg = await page.locator("#lab-fan svg").elementHandle();
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /dark|light/);
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);
  await expect(page.getByRole("button", { name: "+20% supply" })).toHaveAttribute("aria-pressed", "true");
});
