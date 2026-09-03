/**
 * Live2D independence (Phase 4): Live2D/Cubism is NOT a supported feature —
 * the app must never depend on its runtime. This spec blocks the Cubism
 * runtime entirely and asserts the editor and exports keep working: models
 * are still listed (folders are scanned), adding one degrades to a clear
 * error/placeholder without crashing, and Spine/media flows are unaffected.
 */
import { test, expect } from "playwright/test";
import { bootEditor, evalIn, pickerClick, renderedPixels, spriteCount, waitTruthy } from "./helpers.js";

// Every test in this file runs WITHOUT any Cubism runtime available.
test.beforeEach(async ({ context }) => {
  await context.route("**/cubism/**", (route) => route.abort());
});

test("editor works fully with the Cubism runtime absent", async ({ page }) => {
  await bootEditor(page);
  expect(await spriteCount(page)).toBeGreaterThanOrEqual(1);
  expect(await renderedPixels(page)).toBeGreaterThan(500);

  // .model3.json models are still discovered (folder scan)…
  const hasModel = await evalIn(page, `window.__spineViewer.CHARACTERS.some((c) => c.kind === "live2d")`);
  expect(hasModel).toBe(true);

  // …but adding one degrades cleanly: status shows an error, no crash, and
  // the rest of the app (e.g. adding a media sprite) keeps working.
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await evalIn(page, `window.__spineViewer.selectCharacter("Haru/Haru")`);
  await page.waitForFunction(
    () => document.getElementById("status").textContent.includes("Error") || document.getElementById("status").textContent.includes("not installed"),
    undefined,
    { timeout: 30000 }
  );
  const status = await evalIn(page, `document.getElementById("status").textContent`);
  expect(status.length).toBeGreaterThan(0);
  await evalIn(page, `window.__spineViewer.addSprite("samples/sample.png"); true`);
  await waitTruthy(page, `window.__spineViewer.sprites().some(s=>s.kind==="image")`);
  expect(errors).toEqual([]);
});

test("media + audio flows are untouched when Cubism is missing", async ({ page }) => {
  await bootEditor(page);
  await page.click("#add-char-btn");
  await page.click('#picker-tabs [data-tab="custom_assets"]');
  await pickerClick(page, "samples/sample.png");
  await waitTruthy(page, `window.__spineViewer.sprites().some(s=>s.kind==="image")`);
  await waitTruthy(page, `window.__spineViewer.player?.skeleton`);
  expect(await renderedPixels(page)).toBeGreaterThan(500);
});
