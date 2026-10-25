import { defineConfig, devices } from "@playwright/test";

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_PORT,
  API_URL,
  DATABASE_URL,
  WEB_ORIGIN,
  WEB_PORT,
} from "./e2e/env";

const CI = Boolean(process.env.CI);

/**
 * The sandbox E2E (T74): Playwright starts the real stack on its own ports, with a fresh
 * database (scripts/e2e-backend.sh) and a production build of the frontend in `.next-e2e`, and
 * stops both afterwards. `USE_MOCKS=true`, so no keys are needed. Run with `make e2e`.
 * E2E_SKIP_BUILD=1 reuses the last `.next-e2e` build (same E2E_API_PORT) to iterate faster.
 */
export default defineConfig({
  testDir: "./e2e",
  // One journey through shared state: run it once, in order, in one worker.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: CI,
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "api",
      command: "bash ../scripts/e2e-backend.sh",
      url: `${API_URL}/healthz`,
      env: {
        E2E_DATABASE_URL: DATABASE_URL,
        E2E_API_PORT: String(API_PORT),
        E2E_WEB_ORIGIN: WEB_ORIGIN,
        E2E_ADMIN_EMAIL: ADMIN_EMAIL,
        E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
      },
      stdout: "pipe",
      timeout: 3 * 60_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      name: "web",
      // `next start` directly: through pnpm, the stop at the end logs a misleading failure.
      command: `${process.env.E2E_SKIP_BUILD === "1" ? "" : "pnpm build && "}exec ./node_modules/.bin/next start --port ${WEB_PORT}`,
      url: `${WEB_ORIGIN}/`,
      env: {
        // The /api proxy target is baked in at build time (next.config.ts).
        BACKEND_URL: API_URL,
        NEXT_E2E_BUILD: "1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      timeout: 5 * 60_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
