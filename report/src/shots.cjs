// Captures screenshots of the running web app (http://localhost:8080) for the report's UI figure.
//
//   NODE_PATH=<frontend/node_modules> node report/src/shots.cjs
//
// Uses the locally installed Chrome, like the Playwright end-to-end tests.
const { chromium } = require("playwright");
const path = require("path");

const OUT = process.argv[2] || path.join(__dirname, "..", "figures");
const BASE = process.env.E2E_BASE_URL || "http://localhost:8080";
// [file name, route, vertical scroll in CSS pixels]
const PAGES = [
  ["ui_forecast", "#/forecast/A", 372],
  ["ui_bid", "#/bid/A", 250],
];

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 900, height: 700 }, deviceScaleFactor: 3, colorScheme: "light",
  });
  // Light theme, and no first-visit tour offer covering the page.
  await context.addInitScript(() => {
    localStorage.setItem("coe-theme", JSON.stringify("light"));
    localStorage.setItem("coe-tour-seen", JSON.stringify(true));
  });
  const page = await context.newPage();
  for (const [name, hash, scroll] of PAGES) {
    await page.goto(`${BASE}/${hash}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate((y) => window.scrollTo(0, y), scroll);
    await page.waitForTimeout(1500);              // let number and chart animations settle
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("saved", name);
  }
  await browser.close();
})();
