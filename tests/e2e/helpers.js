/**
 * Shared helpers for the Playwright specs.
 *
 * The editor exposes a small automation handle (window.__spineViewer — the
 * same handle the interim BiDi harness drives). The exported wallpaper
 * exposes window.__lwpg.
 */
import { expect } from "playwright/test";

/** Boot the editor and wait until the default sprite's skeleton exists. */
export async function bootEditor(page) {
  await page.goto("/");
  await page.waitForFunction(() => !!window.__spineViewer);
  await page.waitForFunction(() => {
    const p = window.__spineViewer?.player;
    return !!p && !!p.skeleton;
  });
  await page.waitForTimeout(200);
}

/** Evaluate in the page; result is awaited when it is a promise. */
export const evalIn = (page, expression) =>
  page.evaluate(expression);

/** Count non-transparent pixels drawn on the shared stage canvas. */
export const renderedPixels = (page) =>
  evalIn(page, `(() => { const st = window.__spineViewer.stage; st.renderOnce(); return st.canvasPixels().drawn; })()`);

/** Wait until `expr` (an expression string, evaluated in the page) is truthy.
 *  Evaluation errors (e.g. right after a reload before the module boots) are
 *  treated as "not yet" and polling continues. */
export async function waitTruthy(page, expression, { timeout = 30000, interval = 100 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await page.evaluate(expression);
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `Timed out waiting for: ${expression} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`
  );
}

/** Click a picker cell by data-id (any tab; the picker stays open). */
export const pickerClick = (page, id) =>
  evalIn(page, `document.querySelector('.picker-cell[data-id=${JSON.stringify(id)}]')?.click()`);

/** Wait for the active player's loadId to bump (a sprite finished loading). */
export async function waitLoad(page, timeout = 30000) {
  const base = await evalIn(page, `window.__spineViewer.player.loadId`);
  await waitTruthy(page, `window.__spineViewer.player.loadId > ${base}`, { timeout });
}

/** Give the shared canvas a visible spine sprite to inspect. */
export const spriteCount = (page) => evalIn(page, `window.__spineViewer.sprites().length`);

export { expect };
