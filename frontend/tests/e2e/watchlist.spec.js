// Acceptance 5 (invalid targets cannot be submitted), 6 (valid targets are
// normalised and saved) and 7 (duplicates are handled). Each test runs in a
// fresh browser context, so it gets its own anonymous client ID.

import { expect, test } from "./fixtures.js";

async function cleanup(page, request) {
  const cid = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  if (!cid) return;
  for (const a of await (await request.get(`/api/alerts?client_id=${cid}`)).json()) {
    await request.delete(`/api/alerts/${a.id}?client_id=${cid}`);
  }
}

test("invalid targets keep Add disabled and explain why", async ({ page, request }) => {
  await page.goto("/#/alerts");
  const input = page.locator("#a-target");
  const submit = page.locator("#a-submit");
  const error = page.locator("#a-target-error");
  await expect(submit).toBeDisabled();                       // blank
  for (const bad of ["d", "abc", "NaN", "-200", "0", "12..5"]) {
    await input.fill(bad);
    await expect(submit, `"${bad}" must not be accepted`).toBeDisabled();
    await expect(error).toBeVisible();
    await expect(error).toHaveText(/Enter a COE premium/);
    await expect(input).toHaveAttribute("aria-invalid", "true");
  }
  await input.fill("-200");
  await expect(error).toHaveText("Enter a COE premium above $0.");
  // Enter key on an invalid form does not create anything
  await input.fill("d");
  await input.press("Enter");
  await expect(page.locator("[data-alert]")).toHaveCount(0);
  await expect(page.locator("#alerts")).toContainText("Nothing on your watchlist yet");
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await cleanup(page, request);
});

for (const [typed, saved] of [["100000", "$100,000"], ["95,000", "$95,000"], ["$120,000", "$120,000"], ["88k", "$88,000"]]) {
  test(`"${typed}" is normalised and saved as ${saved}`, async ({ page, request }) => {
    await page.goto("/#/alerts");
    await page.locator("#a-target").fill(typed);
    await expect(page.locator("#a-submit")).toBeEnabled();
    await page.locator("#a-submit").click();
    const card = page.locator("[data-alert]");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(`Cat A below ${saved}`);
    await expect(card).toContainText("Next exercise");
    await expect(card.locator(".pill")).toHaveText(/Reached|Likely|Possible|Unlikely/);
    await expect(page.locator("#a-target")).toHaveValue("");
    await cleanup(page, request);
  });
}

test("pasting a formatted amount works", async ({ page, request }) => {
  await page.goto("/#/alerts");
  await page.locator("#a-target").focus();
  await page.evaluate(() => {
    const el = document.getElementById("a-target");
    el.value = "$ 95,000.00";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  });
  await expect(page.locator("#a-submit")).toBeEnabled();
  await page.locator("#a-target").blur();
  await expect(page.locator("#a-target")).toHaveValue("95,000");
  await cleanup(page, request);
});

test("duplicates are blocked in the form and by the API", async ({ page, request }) => {
  await page.goto("/#/alerts");
  await page.locator('[data-seg="a-cat"] button[data-value="B"]').click();
  await page.locator("#a-target").fill("110000");
  await page.locator("#a-submit").click();
  await expect(page.locator("[data-alert]")).toHaveCount(1);

  await page.locator("#a-target").fill("110,000");
  await expect(page.locator("#a-submit")).toBeDisabled();
  await expect(page.locator("#a-target-error")).toHaveText(/already watching Cat B below \$110,000/);
  // Same target, other direction is fine
  await page.locator('[data-seg="a-dir"] button[data-value="above"]').click();
  await expect(page.locator("#a-submit")).toBeEnabled();

  const cid = await page.evaluate(() => JSON.parse(localStorage.getItem("coe-client-id")));
  const dup = await request.post("/api/alerts", { data: { client_id: cid, category: "B", direction: "below", target: 110000 } });
  expect(dup.status()).toBe(409);
  await cleanup(page, request);
});

test("removing a target asks for confirmation", async ({ page, request }) => {
  await page.goto("/#/alerts");
  await page.locator("#a-target").fill("99000");
  await page.locator("#a-submit").click();
  const card = page.locator("[data-alert]");
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: /Remove Cat A below/ }).click();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: /Remove Cat A below/ }).click();
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator("[data-alert]")).toHaveCount(0);
  await cleanup(page, request);
});
