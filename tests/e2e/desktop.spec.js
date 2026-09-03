/**
 * Desktop smoke test (V1.1): launch the Electron shell (`electron .`) and
 * assert the editor window boots against the internal server.
 *
 * Gated behind RUN_ELECTRON=1 because it needs a real display (Windows, or a
 * headless X server on POSIX) plus the local Electron binary
 * (`npm install` downloads it). Full NSIS/installer testing stays manual.
 */
import { test, expect } from "playwright/test";
import { _electron } from "playwright";

const ELECTRON_ARGS = ["."];
// Use a dedicated port so the app never collides with the dev server (8092)
// or a manually running 8080.
const LWPG_PORT = 8137;

test("electron shell opens the working editor", async () => {
  test.skip(!process.env.RUN_ELECTRON, "set RUN_ELECTRON=1 on a machine with a display to run the desktop smoke test");

  const args = [...ELECTRON_ARGS];
  // Container/CI Chromium sandboxes + GPU stacks often can't start; opt out
  // explicitly (harmless on a normal Windows/Linux desktop run).
  if (process.env.LWPG_ELECTRON_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
  }

  const electronApp = await _electron.launch({
    args,
    cwd: process.cwd(),
    env: { ...process.env, LWPG_PORT: String(LWPG_PORT) },
    timeout: 90_000,
  });

  try {
    const page = await electronApp.firstWindow();
    await page.waitForFunction(() => !!window.__spineViewer, undefined, { timeout: 30_000 });
    // The default boot sprite must actually load (server + content served).
    await page.waitForFunction(
      () => {
        const p = window.__spineViewer?.player;
        return !!p && !!p.skeleton;
      },
      undefined,
      { timeout: 40_000 }
    );
    expect(await page.title()).toMatch(/Spinal Board/);

    // Sanity: the editor UI is present and an in-page export request reaches
    // the internal server (small, side-effect-light call is skipped here —
    // full export coverage lives in export.spec.js against the dev server).
    await page.waitForSelector("#export-btn", { timeout: 15_000 });
  } finally {
    await electronApp.close();
  }
});
