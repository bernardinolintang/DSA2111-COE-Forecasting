// Acceptance 9 (Ask Compass receives the right context), 10 (navigation actions
// go to the right place), 11 (persistent actions need confirmation) and 12 (AI
// failure does not break the app). The real backend answers in basic mode when
// no language-model key is configured (or with ANALYST_ENABLED=false); some
// tests mock the endpoint to exercise the action executor deterministically.

import { expect, test } from "./fixtures.js";

// this types a question and sends it so that the tests below stay short
async function ask(page, question) {
  if (!(await page.locator("#analyst").isVisible())) await page.locator("#ask-compass").click();
  await page.locator("#analyst-input").fill(question);
  await page.locator("#analyst-input").press("Enter");
}

// this fakes the analyst reply so that action tests do not depend on wording
function mockReply(page, body, capture) {
  return page.route("**/api/analyst/chat*", async (route) => {
    capture?.push(route.request().postDataJSON());
    await route.fulfill({ json: { mode: "llm", provenance: "Based on test data.", notice: null, actions: [], ...body } });
  });
}

// this checks what the browser sends so that the server knows what the viewer is looking at
test("the request carries the page, category, quota change and bid being viewed", async ({ page }) => {
  const sent = [];
  await mockReply(page, { reply: "ok" }, sent);
  await page.goto("/#/scenario/A?quota=12");
  await expect(page.locator("#lab-median")).not.toHaveText("—");
  await page.locator("#ask-compass").click();
  await expect(page.locator("#analyst-title")).toHaveText("Ask Compass");
  await expect(page.locator("#analyst-where")).toHaveText("Cat A · Scenario Lab · +12% supply");
  await expect(page.locator("#analyst-facts")).toContainText("Supply scenario");
  await expect(page.locator("#analyst-facts")).toContainText("+12% supply (interpolated)");
  await ask(page, "Why did the forecast change?");
  await expect(page.locator(".msg-bot").last()).toContainText("ok");
  expect(sent[0].view).toEqual({ page: "scenario", category: "A", quota_pct: 12 });
  expect(sent[0].messages.at(-1)).toEqual({ role: "user", content: "Why did the forecast change?" });
  expect(sent[0].client_id).toMatch(/^[0-9a-f-]{36}$/);

  await page.goto("/#/bid/C?bid=95000");
  await expect(page.locator("#bid-input")).toHaveValue("95,000");
  await ask(page, "What are my odds?");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].view).toEqual({ page: "bid", category: "C", bid: 95000 });
  await expect(page.locator(".msg-bot .reply")).toHaveCount(2);            // answered: ready for the next question

  // Pages without a category send just the page; the suggestions follow the page.
  await page.goto("/#/learn/faq");
  await expect(page.locator("#analyst-where")).toHaveText("Learn");
  await expect(page.locator("#analyst-suggest")).toContainText("What does the 80% range mean?");
  await ask(page, "hello");
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2].view).toEqual({ page: "learn" });
});

// this checks real navigation answers so that "show me" requests open the right page
test("navigation requests open the right page (real backend)", async ({ page }) => {
  await page.goto("/");
  await ask(page, "Show me Cat E");
  await expect(page).toHaveURL(/#\/forecast\/E$/);
  await expect(page.locator("h1")).toContainText("Cat E");
  await expect(page.locator(".msg-bot .provenance").last()).toContainText("bidding exercise");

  await ask(page, "Take me to the bid planner for Cat A");
  await expect(page).toHaveURL(/#\/bid\/A/);
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);

  await ask(page, "What changed Cat B prices the most historically?");
  await expect(page).toHaveURL(/#\/policy\/B\?event=/);
});

// this checks actions update the page in place so that the viewer keeps their place
test("scenario and bid actions change the page in place", async ({ page }) => {
  await page.goto("/#/scenario/A");
  await expect(page.locator("#lab-median")).not.toHaveText("—");
  const svg = await page.locator("#lab-fan svg").elementHandle();
  await mockReply(page, { reply: "Switching to +20% supply.",
    actions: [{ type: "set_supply_scenario", params: { scenario: "quota_plus_20", quota_pct: 20 }, confirm: false, summary: "Supply scenario: +20% supply" }] });
  await ask(page, "try more supply");
  await expect(page.getByRole("button", { name: "+20% supply" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#quota-out")).toHaveText("+20%");
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);          // not re-rendered

  // Any whole percentage works, not only the modelled scenarios.
  await page.unroute("**/api/analyst/chat*");
  await mockReply(page, { reply: "Trying 7% less.",
    actions: [{ type: "set_supply_scenario", params: { quota_pct: -7 }, confirm: false, summary: "Supply scenario: −7% supply" }] });
  await ask(page, "what about 7% less");
  await expect(page.locator("#quota-out")).toHaveText("−7%");
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);

  await page.unroute("**/api/analyst/chat*");
  await mockReply(page, { reply: "Setting your bid.",
    actions: [{ type: "set_bid_amount", params: { amount: 140000, category: "A" }, confirm: false, summary: "Set bid to $140,000" }] });
  await ask(page, "bid 140k");
  await expect(page).toHaveURL(/#\/bid\/A\?bid=140000/);
  await expect(page.locator("#bid-input")).toHaveValue("140,000");
});

// this checks a supply question from elsewhere so that it lands on the slider at the right value
test("a supply question from another page opens the Scenario Lab at that level", async ({ page }) => {
  await mockReply(page, { reply: "Opening the Scenario Lab.",
    actions: [{ type: "set_supply_scenario", params: { quota_pct: 15, category: "B" }, confirm: false, summary: "Supply scenario: +15% supply" }] });
  await page.goto("/#/forecast/B");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await ask(page, "what if supply rises 15%?");
  await expect(page).toHaveURL(/#\/scenario\/B\?quota=15$/);
  await expect(page.locator("#quota-out")).toHaveText("+15%");
});

// this checks the same flow on the real backend so that the mock does not hide a problem
test("supply what-ifs through the real backend land in the Scenario Lab", async ({ page, request }) => {
  const status = await (await request.get("/api/analyst/status")).json();
  test.skip(status.mode !== "offline", "deterministic wording is only guaranteed in basic mode");
  await page.goto("/");
  await ask(page, "What if supply rises 15% for Cat B?");
  await expect(page).toHaveURL(/#\/scenario\/B\?quota=15$/);
  await expect(page.locator(".msg-bot").last()).toContainText("interpolated");
  await expect(page.locator(".msg-bot .provenance").last()).toContainText("bidding exercise");
});

// this checks the wording so that the analyst never gives a buy or wait call
test("Compass does not tell anyone to buy or to wait (real backend, basic mode)", async ({ page, request }) => {
  const status = await (await request.get("/api/analyst/status")).json();
  test.skip(status.mode !== "offline", "deterministic wording is only guaranteed in basic mode");
  await page.goto("/#/forecast/A");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await ask(page, "Should I buy now or wait?");
  const reply = page.locator(".msg-bot .reply").last();
  await expect(reply).toContainText("doesn't tell you to buy or to wait");
  await expect(reply).toContainText("Cat A shows");
});

// this checks a target stays a draft so that nothing saves until Confirm is pressed
test("watchlist changes are only drafted until the user confirms (real backend)", async ({ page, request }) => {
  await page.goto("/#/alerts");
  await ask(page, "Alert me when Cat A falls below $110k");
  const confirm = page.locator(".confirm-card");
  await expect(confirm).toContainText("Watch Cat A below $110,000");
  const cid = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  expect(await (await request.get(`/api/alerts?client_id=${cid}`)).json()).toEqual([]);   // nothing saved yet

  await confirm.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".action-chip.is-done")).toContainText("Watch Cat A below $110,000");
  const saved = await (await request.get(`/api/alerts?client_id=${cid}`)).json();
  expect(saved.map((a) => [a.category, a.direction, a.target])).toEqual([["A", "below", 110000]]);
  await expect(page.locator("[data-alert]")).toHaveCount(1);                                 // page refreshed
  for (const a of saved) await request.delete(`/api/alerts/${a.id}?client_id=${cid}`);
});

// this checks Cancel so that a dropped draft leaves the list unchanged
test("cancelling a drafted watch saves nothing", async ({ page, request }) => {
  await page.goto("/");
  await ask(page, "watch Cat B above $150,000");
  await page.locator(".confirm-card").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".action-chip.is-muted")).toContainText("cancelled");
  const cid = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  expect(await (await request.get(`/api/alerts?client_id=${cid}`)).json()).toEqual([]);
});

// this breaks the analyst on purpose so that we know the rest of the app still works
test("if Compass is down, the panel says so and the app keeps working", async ({ page, problems }) => {
  await page.route("**/api/analyst/chat*", (route) => route.abort("failed"));
  await page.goto("/#/forecast/A");
  await ask(page, "What does the 80% range mean?");
  await expect(page.locator(".msg-bot.is-error")).toContainText("isn't available right now");
  await expect(page.locator(".msg-bot.is-error").getByRole("button", { name: "Try again" })).toBeVisible();

  await page.getByRole("button", { name: "Close Ask Compass" }).click();
  await page.getByRole("link", { name: "Plan your bid" }).click();
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);
  // The only errors allowed are the ones for the request we deliberately failed.
  expect(problems.filter((p) => !p.includes("/api/analyst/chat") && !p.includes("net::ERR_FAILED"))).toEqual([]);

  await page.unroute("**/api/analyst/chat*");
  await page.route("**/api/analyst/chat*", (route) => route.fulfill({ status: 500, json: { detail: "Internal error" } }));
  await ask(page, "hello");
  await expect(page.locator(".msg-bot.is-error").last()).toContainText("Internal error");
});

// this checks the popover with no AI so that terms are still explained in basic mode
test("explain popover works without the AI and can hand over to Compass", async ({ page }) => {
  const sent = [];
  await mockReply(page, { reply: "Here's what the 80% range means for Cat A." }, sent);
  await page.goto("/#/forecast/A");
  await page.locator("#chart-card").getByRole("button", { name: "Explain: 80% range" }).click();
  const pop = page.locator(".popover");
  await expect(pop).toContainText("8 times out of 10");
  await pop.getByText("Technical detail").click();
  await expect(pop).toContainText("p10–p90");
  await pop.getByRole("button", { name: /Ask Compass about this/ }).click();
  await expect(page.locator(".msg-bot").last()).toContainText("80% range");
  expect(sent[0].messages.at(-1).content).toContain("80% range");
});

// this checks the explain buttons on the outlook so that the hard terms can be read in place
test("the outlook and uncertainty are explained in place", async ({ page }) => {
  await page.goto("/#/forecast/A");
  await page.locator("#advice").getByRole("button", { name: "Explain: market outlook" }).click();
  const pop = page.locator(".popover");
  await expect(pop).toContainText("It is not advice to buy or to wait");
  await page.keyboard.press("Escape");
  await page.locator("#advice").getByRole("button", { name: "Explain: model uncertainty" }).click();
  await expect(pop).toContainText("How wide the forecast's 80% range is");
});

// this checks the thinking state and real streaming so that there is no fake typewriter effect
test("shows a thinking state, then the answer as it arrives (no typewriter)", async ({ page }) => {
  const long = "The model's median for Cat A is flat, so no clear direction is the honest reading. ".repeat(12).trim();
  await page.route("**/api/analyst/chat*", async (route) => {
    await new Promise((r) => setTimeout(r, 700));             // the model is "thinking"
    const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await route.fulfill({
      status: 200, headers: { "content-type": "text/event-stream" },
      body: sse("status", { text: "Thinking…" }) + sse("delta", { text: long })
        + sse("done", { actions: [], mode: "llm", provenance: "Based on test data.", notice: null }),
    });
  });
  await page.goto("/");
  await ask(page, "Why do all categories show the same outlook?");
  const thinking = page.locator(".bubble.thinking");
  await expect(thinking).toBeVisible();
  await expect(thinking).toContainText("Thinking…");
  await expect(page.locator(".analyst-send")).toBeDisabled();       // one question at a time
  const reply = page.locator(".msg-bot .reply").last();
  await reply.waitFor();
  expect(await reply.textContent()).toBe(long);                     // shown whole the moment it arrives
  await expect(page.locator(".msg-bot .provenance")).toContainText("Based on test data.");
  await expect(page.locator(".msg-bot .caret")).toHaveCount(0);
  await expect(page.locator(".analyst-send")).toBeEnabled();
});

// this checks the event stream so that the real backend streams as expected
test("the real backend streams the answer as server-sent events", async ({ page }) => {
  await page.goto("/#/forecast/A");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/analyst/chat")),
    ask(page, "Why is Cat A showing no clear direction?"),
  ]);
  expect(res.headers()["content-type"]).toContain("text/event-stream");
  await expect(page.locator(".msg-bot .provenance").last()).toContainText("Cat A forecast");
});

// this checks the panel closes for the tour so that it does not cover the spotlight
test("starting the tour moves Ask Compass out of the way", async ({ page }) => {
  await page.goto("/");
  await page.locator("#ask-compass").click();
  await expect(page.locator("#analyst")).toBeVisible();
  await page.getByRole("button", { name: "Help" }).click();               // header stays reachable
  await page.getByRole("menuitem", { name: /Take the 2-minute tour/ }).click();
  await expect(page.locator(".tour-card")).toBeVisible();
  await expect(page.locator("#analyst")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tour-card")).toHaveCount(0);
  await page.locator("#ask-compass").click();                             // usable again once the tour ends
  await expect(page.locator("#analyst")).toBeVisible();
});
