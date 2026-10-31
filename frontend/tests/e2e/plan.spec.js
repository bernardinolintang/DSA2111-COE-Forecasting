// My plan: a few answers become a personal summary (outlook, forecast range,
// budget check, a level to watch), and renewals get a PQP estimate. Answers stay
// in the browser; the only thing saved on the server is a target the user adds.

import { expect, test } from "./fixtures.js";

const money = (v) => `$${Math.round(v).toLocaleString("en-SG")}`;

// this removes test targets so that runs do not affect each other
async function cleanup(page, request) {
  const cid = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  if (!cid) return;
  for (const a of await (await request.get(`/api/alerts?client_id=${cid}`)).json()) {
    await request.delete(`/api/alerts/${a.id}?client_id=${cid}`);
  }
}

// this checks the buyer path so that the plan and budget survive a reload
test("buying: outlook, forecast range and a budget check, kept across reloads", async ({ page, request, problems }) => {
  const s = await (await request.get("/api/summary")).json();
  const a = s.categories[0];
  await page.goto("/#/plan?intent=buy");
  const result = page.locator("#plan-result");
  await expect(result).toContainText("Your COE plan");
  await expect(result.locator(".plan-title")).toContainText("Cat A");
  await expect(result.locator(".pill")).toHaveText(a.signal.label);
  await expect(result).toContainText(a.next_label);
  await expect(result).toContainText("likely range at the next exercise");
  await expect(result).toContainText("Add a COE budget");
  await expect(result).toContainText(`run #${s.run.id}`);
  await expect(result).toContainText("does not tell you to buy or to wait");

  // A budget is compared with the forecast, in words and odds.
  const budget = Math.round(a.next_q50 / 1000) * 1000 - 3000;
  await page.locator("#plan-budget").fill(String(budget));
  await expect(result).toContainText(`${money(budget)} is`);
  await expect(result).toContainText("below the median forecast for the next exercise");
  await expect(result).toContainText(/about a \d+% chance the premium is at or below your budget/);
  await expect(result.locator("#plan-watch")).toHaveText(`Watch Cat A below ${money(budget)}`);

  // Nonsense is rejected and leaves the plan as it was.
  await page.locator("#plan-budget").fill("abc");
  await expect(page.locator("#plan-budget-error")).toBeVisible();
  await expect(page.locator("#plan-budget")).toHaveAttribute("aria-invalid", "true");
  await expect(result).toContainText(`${money(budget)} is`);

  // Timing beyond the horizon is answered honestly.
  await page.locator('[data-seg="timing"] button[data-value="later"]').click();
  await expect(result).toContainText("forecasts one quota quarter ahead");

  // Another category, then reload: the answers are remembered in this browser.
  await page.locator('[data-seg="plan-cat"] button[data-value="D"]').click();
  await expect(result.locator(".plan-title")).toContainText("Cat D");
  await page.locator("#plan-budget").fill("12,000");
  await expect(result).toContainText("$12,000 is");
  await page.goto("/#/plan");
  await page.reload();
  await expect(page.locator("#plan-budget")).toHaveValue("12,000");
  await expect(page.locator('[data-seg="plan-cat"] button[data-value="D"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-seg="timing"] button[data-value="later"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#plan-result .plan-title")).toContainText("Cat D");
  expect(problems).toEqual([]);
});

// this checks the renewal path so that the PQP uses real results then the forecast
test("renewing: PQP estimated from recorded results, then projected with the forecast", async ({ page, request }) => {
  const h = (await (await request.get("/api/history/B?years=1")).json()).points;
  await page.goto("/#/plan?intent=renew");
  const result = page.locator("#plan-result");
  await expect(result).toContainText("Your renewal outlook");
  await expect(page.locator("#plan-timing-field")).toBeHidden();
  await expect(page.locator("#plan-budget-field")).toBeHidden();
  await page.locator('[data-seg="plan-cat"] button[data-value="B"]').click();
  await expect(result.locator(".plan-title")).toContainText("Cat B");

  const rows = result.locator("table.data tbody tr");
  await expect(rows.first()).toBeVisible();
  if (h[h.length - 1].bidding_no === 2) {
    // The month after the latest result: the average of the six exercises in the three months before it.
    const pqp = h.slice(-6).reduce((sum, p) => sum + p.premium, 0) / 6;
    await expect(result.locator(".plan-figure")).toHaveText(money(pqp));
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText("Recorded");
    await expect(rows.first()).toContainText(money(pqp / 2));              // the 5-year option costs half
    await expect(rows.last()).toContainText("All forecast");
  }
  await expect(result).toContainText("cannot be renewed again");
  await expect(result).toContainText("LTA publishes the official PQP");

  await page.locator('[data-seg="plan-cat"] button[data-value="E"]').click();
  await expect(result).toContainText("Choose your vehicle's category");
  await expect(page.locator("#plan-cat-note")).toContainText("Cat E is an open category for bidding only");
});

// this checks the watch button so that nothing goes to the server without a click
test("the watch level is only saved when the user asks", async ({ page, request }) => {
  await page.goto("/#/plan?intent=buy");
  const btn = page.locator("#plan-watch");
  await expect(btn).toBeVisible();
  const cid = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  if (cid) expect(await (await request.get(`/api/alerts?client_id=${cid}`)).json()).toEqual([]);

  const target = Number(await btn.getAttribute("data-target"));
  await btn.click();
  await expect(btn).toHaveText("Added to your watchlist");
  await expect(btn).toBeDisabled();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  const saved = await (await request.get(`/api/alerts?client_id=${id}`)).json();
  expect(saved.map((x) => [x.category, x.direction, x.target, x.label])).toEqual([["A", "below", target, "From my COE plan"]]);

  await page.locator('.subnav a[data-sub="alerts"]').click();
  await expect(page.locator("[data-alert]")).toContainText(`Cat A below ${money(target)}`);
  await cleanup(page, request);
});
