// Learn: the COE guide, how the forecasts are made, data sources, FAQ and About.
// Each section renders with live facts, links to the tools it describes, and is
// reachable from the footer and the Help menu.

import { expect, test } from "./fixtures.js";

const SECTIONS = [
  ["/#/learn", "How COE works.", "COE guide", "What is a COE?"],
  ["/#/learn/how", "How COE Compass makes forecasts.", "How it works", "Why is the forecast a range rather than one number?"],
  ["/#/learn/sources", "Where the data comes from.", "Data sources", "COE bidding results"],
  ["/#/learn/faq", "Using COE Compass.", "FAQ and help", "How do I use the Bid planner?"],
  ["/#/learn/about", "About COE Compass.", "About", "Not a government service."],
];

for (const [url, title, tab, text] of SECTIONS) {
  test(`Learn: ${tab}`, async ({ page, problems }) => {
    await page.goto(url);
    await expect(page.locator("h1")).toHaveText(title);
    await expect(page.locator('.subnav a[aria-current="page"]')).toHaveText(tab);
    await expect(page.locator("#learn-body")).toContainText(text);
    await expect(page.locator("#learn-body .skeleton")).toHaveCount(0);
    await expect(page.locator("#app")).not.toContainText(/NaN|undefined/);
    expect(problems).toEqual([]);
  });
}

test("the COE guide answers the basics and links to the tools", async ({ page }) => {
  await page.goto("/#/learn");
  const body = page.locator("#learn-body");
  await expect(body.locator("details.faq-item")).toHaveCount(6);
  await expect(body.locator("details[open]")).toHaveCount(1);                   // the first answer is open
  await body.getByText("What are Categories A to E?").click();
  await expect(body.locator("table.data tbody tr")).toHaveCount(5);
  await body.getByText("What happens when my COE expires?").click();
  await expect(body).toContainText("Prevailing Quota Premium (PQP)");
  await body.getByRole("button", { name: "Explain: Prevailing Quota Premium" }).click();
  await expect(page.locator(".popover")).toContainText("average of the premiums");
  await page.keyboard.press("Escape");
  await body.getByRole("link", { name: "My plan" }).click();
  await expect(page).toHaveURL(/#\/plan\?intent=renew$/);
});

test("how it works: five steps, live model facts and an honest answer about guarantees", async ({ page, request }) => {
  const [s, m] = await Promise.all(["/api/summary", "/api/model/metrics"].map(async (u) => (await request.get(u)).json()));
  const ours = m.leaderboard.find((r) => r.model === "hybrid");
  await page.goto("/#/learn/how");
  const body = page.locator("#learn-body");
  await expect(body.locator(".pipeline .step h3")).toHaveText(["Collect", "Model", "Validate", "Quantify uncertainty", "Publish"]);
  await expect(body).toContainText(`model run #${s.run.id}`);
  await expect(body).toContainText(s.data_through.label);
  await body.getByText("Can COE Compass guarantee the next premium?").click();
  await expect(body).toContainText("No.");
  await expect(body).toContainText(`${ours.mape.toFixed(1)}% on average`);
  await body.getByText("What does the market outlook mean, and why doesn't it say buy or wait?").click();
  await expect(body).toContainText("leaves the decision with you");
  await body.getByRole("link", { name: "View the technical methodology and evaluation" }).click();
  await expect(page).toHaveURL(/#\/model\?section=technical$/);
  await expect(page.locator("#technical")).toHaveAttribute("open", "");
});

test("data sources name the publishers, the freshness and the audit trail", async ({ page, request }) => {
  const s = await (await request.get("/api/summary")).json();
  await page.goto("/#/learn/sources");
  const body = page.locator("#learn-body");
  await expect(body.locator("table.sources tbody tr")).toHaveCount(3);
  await expect(body.getByRole("link", { name: /data\.gov\.sg/ })).toHaveAttribute("href", /^https:\/\/data\.gov\.sg\/datasets\//);
  await expect(body).toContainText("Singapore Open Data Licence");
  await expect(body).toContainText(`Results through the ${s.data_through.label} bidding exercise are included`);
  await expect(body).toContainText(`model run #${s.run.id}`);
  await expect(body).toContainText("A-2026-10-E1-r39");
  await expect(body).toContainText("not affiliated with or endorsed by LTA");
});

test("FAQ and help open the tour, the glossary and Ask Compass", async ({ page }) => {
  await page.goto("/#/learn/faq");
  const body = page.locator("#learn-body");
  await body.getByRole("button", { name: "What the terms mean" }).click();
  await expect(page.locator("#glossary-dialog")).toContainText("Market outlook");
  await expect(page.locator("#glossary-dialog")).toContainText("Prevailing Quota Premium");
  await page.keyboard.press("Escape");
  await body.getByRole("button", { name: "Ask Compass" }).click();
  await expect(page.locator("#analyst")).toBeVisible();
  await page.locator("#analyst-close").click();
  await body.getByRole("button", { name: "Take the 2-minute tour" }).click();
  await expect(page.locator(".tour-card .tour-title")).toHaveText("Today's market");
  await page.keyboard.press("Escape");
});

test("footer and Help menu lead to About, methodology, sources and FAQ", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toContainText("Independent COE decision-support platform powered by public data");
  await expect(footer).toContainText("Not affiliated with or endorsed by the Land Transport Authority");
  for (const [name, hash] of [["About", "#/learn/about"], ["Methodology", "#/learn/how"], ["Data sources", "#/learn/sources"],
                              ["Model performance", "#/model"], ["FAQ and help", "#/learn/faq"], ["Privacy", "#/learn/about"]]) {
    await expect(footer.getByRole("link", { name, exact: true })).toHaveAttribute("href", hash);
  }
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: /FAQ and help/ }).click();
  await expect(page).toHaveURL(/#\/learn\/faq$/);
  await expect(page.locator("h1")).toHaveText("Using COE Compass.");
});
