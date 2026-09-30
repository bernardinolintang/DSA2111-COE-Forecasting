// End-to-end tests against a running stack (docker compose up), default http://localhost:8080.
// Uses the locally installed Chrome, so no browser download is needed:
//   cd frontend && npm install && npx playwright test
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:8080",
    channel: process.env.E2E_CHANNEL || "chrome",
    viewport: { width: 1366, height: 900 },
    trace: "retain-on-failure",
  },
});
