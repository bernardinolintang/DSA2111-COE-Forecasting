// Acceptance 8: the tour can be started, skipped, completed and reopened.

import { expect, test } from "./fixtures.js";

test.use({ tourSeen: false });

const TITLES = ["Today's market", "Read a forecast", "Test supply scenarios", "Plan a bid",
                "Understand why", "Why trust the model?", "Watch a target"];
const HASHES = [/:\d+\/(#\/)?$/, /#\/forecast\/A/, /#\/scenario\/A/, /#\/bid\/A/, /#\/policy\/B/, /#\/model/, /#\/alerts/];

test("first visit offers the tour without forcing it; Not now remembers", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tour-offer")).toContainText("New to COE Compass?");
  await expect(page.locator(".tour-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Not now" }).click();
  await page.reload();
  await expect(page.locator("#cards .cat-card").first()).toBeVisible();
  await expect(page.locator(".tour-offer")).toHaveCount(0);
});

test("complete the tour: 7 steps across the app with Back and Next", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Take the tour" }).click();
  const card = page.locator(".tour-card");
  for (let i = 0; i < 7; i++) {
    await expect(card.locator(".tour-title")).toHaveText(TITLES[i]);
    await expect(card).toContainText(`Step ${i + 1} of 7`);
    await expect(page).toHaveURL(HASHES[i]);
    await expect(page.locator(".tour-spot")).toBeVisible();
    if (i === 3) {                                         // Back once, then continue
      await card.getByRole("button", { name: "Back" }).click();
      await expect(card.locator(".tour-title")).toHaveText(TITLES[2]);
      await card.getByRole("button", { name: "Next" }).click();
      await expect(card.locator(".tour-title")).toHaveText(TITLES[3]);
    }
    if (i < 6) await card.getByRole("button", { name: "Next" }).click();
  }
  await card.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("coe-tour-seen"))).toBe("true");
});

test("skip with the button or Escape, then reopen from Help", async ({ page }) => {
  await page.goto("/#/forecast/A");
  await page.getByRole("button", { name: "Take the tour" }).click();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page.locator(".tour-card")).toHaveCount(0);

  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: /Take the 2-minute tour/ }).click();
  await expect(page.locator(".tour-card .tour-title")).toHaveText(TITLES[0]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".tour-card")).toHaveCount(0);
});

test("the last step hands over to the analyst", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Take the tour" }).click();
  for (let i = 0; i < 6; i++) await page.locator(".tour-card").getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: /ask Compass anything/ }).click();
  await expect(page.locator("#analyst")).toBeVisible();
});
