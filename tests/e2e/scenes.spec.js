/**
 * Scene manager CRUD (Playwright migration, Phase 4): new-empty-scene
 * isolation (own sprites + layers), switch-back fidelity, rename and delete.
 */
import { test, expect } from "playwright/test";
import { bootEditor, evalIn, waitTruthy } from "./helpers.js";

test("scenes isolate sprites and layers; rename/delete work", async ({ page }) => {
  await bootEditor(page);
  const scenes0 = await evalIn(page, `window.__spineViewer.scenes.list().length`);
  expect(scenes0).toBe(1);

  // Give the first scene sprites, then create a NEW EMPTY scene — none of the
  // current sprites may carry over.
  await evalIn(page, `(() => { window.__spineViewer.addSprite("c313-2"); return true; })()`);
  await waitTruthy(page, `window.__spineViewer.sprites().length >= 2`);
  const before = await evalIn(page, `window.__spineViewer.sprites().length`);

  await evalIn(page, `document.getElementById("scenes-new").click(); true`);
  await waitTruthy(page, `window.__spineViewer.scenes.list().length === 2`);
  await waitTruthy(page, `window.__spineViewer.sprites().length === 0`);
  const scenes = await evalIn(page, `window.__spineViewer.scenes.list().map((s) => s.id)`);
  expect(scenes.length).toBe(2);
  expect(before).toBeGreaterThanOrEqual(2);

  // Put a sprite + its own layer into the empty scene.
  await evalIn(page, `window.__spineViewer.selectCharacter("c313-2"); true`);
  await waitTruthy(page, `window.__spineViewer.player?.skeleton`);
  await evalIn(page, `window.__spineViewer.layers.add("Scene-2 layer"); true`);

  // Switch back to scene 1: its own sprites, no foreign layer.
  await evalIn(page, `window.__spineViewer.scenes.switch(${JSON.stringify(scenes[0])}); true`);
  await waitTruthy(page, `window.__spineViewer.sprites().length >= 2`);
  const back1 = await evalIn(page, `(() => ({
    count: window.__spineViewer.sprites().length,
    layers: window.__spineViewer.layers.list().map((l) => l.name),
  }))()`);
  expect(back1.count).toBeGreaterThanOrEqual(2);
  expect(back1.layers).not.toContain("Scene-2 layer");

  // Back to the empty scene: sprite + custom layer intact.
  await evalIn(page, `window.__spineViewer.scenes.switch(${JSON.stringify(scenes[1])}); true`);
  await waitTruthy(page, `window.__spineViewer.player?.skeleton`);
  const back2 = await evalIn(page, `(() => ({
    count: window.__spineViewer.sprites().length,
    layers: window.__spineViewer.layers.list().map((l) => l.name),
  }))()`);
  expect(back2.count).toBe(1);
  expect(back2.layers).toContain("Scene-2 layer");

  // Rename + delete.
  await evalIn(page, `window.__spineViewer.scenes.rename(${JSON.stringify(scenes[1])}, "Renamed"); true`);
  await evalIn(page, `window.__spineViewer.scenes.remove(${JSON.stringify(scenes[0])}); true`);
  const remaining = await evalIn(page, `window.__spineViewer.scenes.list()`);
  expect(remaining.length).toBe(1);
  expect(remaining[0].name).toBe("Renamed");
});
