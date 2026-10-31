// Shared test fixture: a page that skips the first-visit tour offer (unless a
// test opts in) and records console errors, failed requests and page errors.

import { test as base, expect } from "@playwright/test";

// this extends the base test so that each test fails on console errors and skips the tour offer
export const test = base.extend({
  tourSeen: [true, { option: true }],
  problems: async ({}, use) => { await use([]); },
  page: async ({ page, tourSeen, problems }, use) => {
    if (tourSeen) await page.addInitScript(() => localStorage.setItem("coe-tour-seen", "true"));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => {
      if (!r.url().includes("fonts.g") && r.failure()?.errorText !== "net::ERR_ABORTED") problems.push(`requestfailed: ${r.url()}`);
    });
    await use(page);
  },
});
export { expect };

/** Wait until the router has rendered the page and its main data. */
// this waits for the home data so that tests start once the app has loaded
export async function ready(page) {
  await page.waitForFunction(() => !document.querySelector("#app [aria-busy='true']"));
}
