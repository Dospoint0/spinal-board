/**
 * Playwright end-to-end configuration (Phase 4 complete — this suite replaced
 * the former WebDriver-BiDi harness scripts/e2e-test.mjs).
 *
 * The dev server is started automatically on 127.0.0.1:8092 (port 8092 keeps
 * it clear of any manually-running 8080 dev server). Browsers are kept in the
 * workspace cache (.pw-browsers, git-ignored) so `npm test` works without a
 * system-wide browser cache.
 */
import { defineConfig } from "playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, ".pw-browsers");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8092",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Headless environments (containers/CI) often lack a usable Chromium
    // sandbox; disable it there — harmless locally.
    launchOptions: { args: ["--no-sandbox"] },
  },
  webServer: {
    command: "node scripts/serve.mjs 8092",
    url: "http://127.0.0.1:8092",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
