// Acceptance 9 (analyst receives the right context), 10 (navigation actions go
// to the right place), 11 (persistent actions need confirmation) and 12 (AI
// failure does not break the app). The real backend answers in basic mode when
// no ANTHROPIC_API_KEY is configured; some tests mock the endpoint to exercise
// the action executor deterministically.

import { expect, test } from "./fixtures.js";

async function ask(page, question) {
  if (!(await page.locator("#analyst").isVisible())) await page.getByRole("button", { name: "Ask COE Analyst" }).click();
  await page.locator("#analyst-input").fill(question);
  await page.locator("#analyst-input").press("Enter");
}

function mockReply(page, body, capture) {
  return page.route("**/api/analyst/chat*", async (route) => {
    capture?.push(route.request().postDataJSON());
    await route.fulfill({ json: { mode: "llm", provenance: "Based on test data.", notice: null, actions: [], ...body } });
  });
}

test("the request carries the page, category, scenario and bid being viewed", async ({ page }) => {
  const sent = [];
  await mockReply(page, { reply: "ok" }, sent);
  await page.goto("/#/forecast/A?scenario=quota_plus_10");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: "Ask COE Analyst" }).click();
  await expect(page.locator("#analyst-where")).toHaveText("Cat A · Forecast · +10% supply");
  await expect(page.locator("#analyst-facts")).toContainText("Current premium");
  await expect(page.locator("#analyst-facts")).toContainText("+10% supply");
  await ask(page, "Why is this saying Lean buy?");
  await expect(page.locator(".msg-bot").last()).toContainText("ok");
  expect(sent[0].view).toEqual({ page: "forecast", category: "A", scenario: "quota_plus_10" });
  expect(sent[0].messages.at(-1)).toEqual({ role: "user", content: "Why is this saying Lean buy?" });
  expect(sent[0].client_id).toMatch(/^[0-9a-f-]{36}$/);

  await page.goto("/#/bid/C?bid=95000");
  await expect(page.locator("#bid-input")).toHaveValue("95,000");
  await ask(page, "What are my odds?");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].view).toEqual({ page: "bid", category: "C", bid: 95000 });
});

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

test("scenario and bid actions change the page in place", async ({ page }) => {
  await page.goto("/#/forecast/A");
  await expect(page.locator("#steps tbody tr")).toHaveCount(6);
  const svg = await page.locator("#fan svg").elementHandle();
  await mockReply(page, { reply: "Switching to +20% supply.",
    actions: [{ type: "set_supply_scenario", params: { scenario: "quota_plus_20" }, confirm: false, summary: "Supply scenario: +20% supply" }] });
  await ask(page, "try more supply");
  await expect(page.getByRole("button", { name: "+20% supply" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#steps-sub")).toContainText("+20% supply");
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);          // not re-rendered

  await page.unroute("**/api/analyst/chat*");
  await mockReply(page, { reply: "Setting your bid.",
    actions: [{ type: "set_bid_amount", params: { amount: 140000, category: "A" }, confirm: false, summary: "Set bid to $140,000" }] });
  await ask(page, "bid 140k");
  await expect(page).toHaveURL(/#\/bid\/A\?bid=140000/);
  await expect(page.locator("#bid-input")).toHaveValue("140,000");
});

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

test("cancelling a drafted watch saves nothing", async ({ page, request }) => {
  await page.goto("/");
  await ask(page, "watch Cat B above $150,000");
  await page.locator(".confirm-card").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".action-chip.is-muted")).toContainText("cancelled");
  const cid = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  expect(await (await request.get(`/api/alerts?client_id=${cid}`)).json()).toEqual([]);
});

test("if the analyst is down, the panel says so and the app keeps working", async ({ page, problems }) => {
  await page.route("**/api/analyst/chat*", (route) => route.abort("failed"));
  await page.goto("/#/forecast/A");
  await ask(page, "What does the 80% range mean?");
  await expect(page.locator(".msg-bot.is-error")).toContainText("isn't available right now");
  await expect(page.locator(".msg-bot.is-error").getByRole("button", { name: "Try again" })).toBeVisible();

  await page.getByRole("button", { name: "Close the analyst" }).click();
  await page.locator('a[data-nav="bid"]').click();
  await expect(page.locator("#cdf svg .series-line")).toHaveCount(1);
  // The only errors allowed are the ones for the request we deliberately failed.
  expect(problems.filter((p) => !p.includes("/api/analyst/chat") && !p.includes("net::ERR_FAILED"))).toEqual([]);

  await page.unroute("**/api/analyst/chat*");
  await page.route("**/api/analyst/chat*", (route) => route.fulfill({ status: 500, json: { detail: "Internal error" } }));
  await ask(page, "hello");
  await expect(page.locator(".msg-bot.is-error").last()).toContainText("Internal error");
});

test("explain popover works without the AI and can hand over to the analyst", async ({ page }) => {
  const sent = [];
  await mockReply(page, { reply: "Here's what the 80% range means for Cat A." }, sent);
  await page.goto("/#/forecast/A");
  await page.getByRole("button", { name: "Explain: 80% range" }).click();
  const pop = page.locator(".popover");
  await expect(pop).toContainText("8 times out of 10");
  await pop.getByText("Technical detail").click();
  await expect(pop).toContainText("p10–p90");
  await pop.getByRole("button", { name: /Ask the analyst/ }).click();
  await expect(page.locator(".msg-bot").last()).toContainText("80% range");
  expect(sent[0].messages.at(-1).content).toContain("80% range");
});

test("shows a thinking state, then the answer as it arrives (no typewriter)", async ({ page }) => {
  const long = "The model's median for Cat A is flat, so waiting is unlikely to save much. ".repeat(12).trim();
  await page.route("**/api/analyst/chat*", async (route) => {
    await new Promise((r) => setTimeout(r, 700));             // the model is "thinking"
    const sse = (event, data) => `event: ${event}
data: ${JSON.stringify(data)}

`;
    await route.fulfill({
      status: 200, headers: { "content-type": "text/event-stream" },
      body: sse("status", { text: "Thinking…" }) + sse("delta", { text: long })
        + sse("done", { actions: [], mode: "llm", provenance: "Based on test data.", notice: null }),
    });
  });
  await page.goto("/");
  await ask(page, "Why do all categories say Lean buy?");
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

test("the real backend streams the answer as server-sent events", async ({ page }) => {
  await page.goto("/#/forecast/A");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/analyst/chat")),
    ask(page, "Why is Cat A saying Lean buy?"),
  ]);
  expect(res.headers()["content-type"]).toContain("text/event-stream");
  await expect(page.locator(".msg-bot .provenance").last()).toContainText("Cat A forecast");
});

test("starting the tour moves the analyst out of the way", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ask COE Analyst" }).click();
  await expect(page.locator("#analyst")).toBeVisible();
  await page.getByRole("button", { name: "Help" }).click();               // header stays reachable
  await page.getByRole("menuitem", { name: /Take the 2-minute tour/ }).click();
  await expect(page.locator(".tour-card")).toBeVisible();
  await expect(page.locator("#analyst")).toBeHidden();
  await expect(page.locator(".analyst-fab")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator(".analyst-fab")).toBeVisible();
});
