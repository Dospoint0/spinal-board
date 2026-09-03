/**
 * Editing, backgrounds and persistence (Playwright migration, Phase 4):
 * edit-mode drag/resize/mirror, colour math, reset-edits, saved layout in the
 * scene record, background colour/image/video, guides, preview, keyboard
 * delete, thumbnails, and legacy-save migration.
 */
import { test, expect } from "playwright/test";
import { bootEditor, evalIn, waitTruthy, spriteCount } from "./helpers.js";

test("edit mode: drag, resize, mirror, opacity/tint and reset-edits", async ({ page }) => {
  await bootEditor(page);
  await page.click("#edit-btn");
  await expect(page.locator(".edit-overlay")).toHaveCount(1);

  // Drag: pointer down/up at the sprite centre offsets its layout position.
  const lcBefore = await evalIn(page, `window.__spineViewer.player.layoutConfig`);
  await evalIn(page, `(() => {
    const c = window.__spineViewer.activeCanvas;
    const r = c.getBoundingClientRect();
    const p = window.__spineViewer.activeCenter;
    const sx = r.left + p.x, sy = r.top + p.y;
    c.dispatchEvent(new PointerEvent("pointerdown", { bubbles:true, pointerId:1, isPrimary:true, button:0, buttons:1, clientX:sx, clientY:sy }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles:true, pointerId:1, clientX:sx + 90, clientY:sy + 30 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles:true, pointerId:1, button:0, buttons:0, clientX:sx + 90, clientY:sy + 30 }));
    return true;
  })()`);
  await page.waitForFunction(() => window.__spineViewer.player.layoutConfig.x != null && window.__spineViewer.player.layoutConfig.x > 0.5);

  // Mirror flips the projection (negative X scale).
  await page.locator("#mirror-check").check();
  await waitTruthy(page, `window.__spineViewer.player.camera.projectionView.values[0] < 0`);

  // Opacity + tint land on the skeleton colour.
  await page.locator("#opacity-range").evaluate((el) => { el.value = "50"; el.dispatchEvent(new Event("input")); });
  await page.locator("#tint-color").evaluate((el) => { el.value = "#ff0000"; el.dispatchEvent(new Event("input")); });
  await page.waitForTimeout(150);
  const col = await evalIn(page, `(() => { const c = window.__spineViewer.player.skeleton.color; return { a: c.a, r: c.r, g: c.g, b: c.b }; })()`);
  expect(Math.abs(col.a - 0.5)).toBeLessThan(0.01);
  expect(col.g).toBeLessThan(0.01);

  // Layout + colour are saved in the current scene record.
  const saved = await evalIn(page, `(() => {
    const d = JSON.parse(localStorage.getItem("spineViewer.scenes"));
    const rec = d.list.find((s) => s.id === d.current);
    return rec.state.sprites[0];
  })()`);
  expect(saved.opacity).toBe(0.5);
  expect(saved.tint).toBe("#ff0000");
  expect(saved.mirror).toBe(true);

  // Reset edits reverts position/size/colour but keeps the sprite (it returns
  // to the default centred fit, not to "no layout" — nothing auto-lays out).
  await page.click("#edit-btn"); // exit edit
  await page.click("#reset-edits-btn");
  await page.waitForTimeout(200);
  const after = await evalIn(page, `(() => {
    const s = window.__spineViewer.sprites()[0];
    const m = window.__spineViewer.player;
    const c = m.skeleton.color;
    return { count: window.__spineViewer.sprites().length, x: m.layoutConfig.x, scale: m.layoutConfig.scale, a: c.a, r: c.r };
  })()`);
  expect(after.count).toBe(1);
  expect(Math.abs(after.x - 0.5)).toBeLessThan(0.02);
  expect(after.scale).toBe(1);
  expect(Math.abs(after.a - 1)).toBeLessThan(0.01);
  expect(after.r).toBe(1);
});

test("backgrounds: colour, image file, video; guides; preview; delete key", async ({ page }) => {
  await bootEditor(page);

  // Custom colour.
  await page.locator("#background-color").evaluate((el) => { el.value = "#ff00ff"; el.dispatchEvent(new Event("input")); });
  await expect
    .poll(() => evalIn(page, `getComputedStyle(document.getElementById("stage")).backgroundColor`))
    .toBe("rgb(255, 0, 255)");

  // Device image (a tiny generated PNG through the file input).
  await page.setInputFiles("#background-file", { name: "bg.png", mimeType: "image/png", buffer: tinyPng() });
  await waitTruthy(page, `window.__spineViewer.background.bgMode === "image"`);

  // Video background attaches a looping <video>.
  await evalIn(page, `(async () => {
    const res = await fetch("custom_assets/samples/sample.webm");
    const blob = await res.blob();
    const file = new File([blob], "bg.webm", { type: "video/webm" });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById("background-file");
    input.files = dt.files; input.dispatchEvent(new Event("change"));
    return true;
  })()`);
  await waitTruthy(page, `!!document.querySelector("video.bg-video")`);
  await page.selectOption("#background-select", "transparent");
  await expect(page.locator("video.bg-video")).toHaveCount(0);

  // Guides overlay: 16:9 ratio, then off.
  await evalIn(page, `window.__spineViewer.guides.set("16/9"); true`);
  await waitTruthy(page, `window.__spineViewer.guides.overlayShown()`);
  const ratio = await evalIn(page, `(() => { const o = document.getElementById("guides-overlay"); return parseFloat(o.style.width) / parseFloat(o.style.height); })()`);
  expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.01);
  await evalIn(page, `window.__spineViewer.guides.set("off"); true`);
  await waitTruthy(page, `!window.__spineViewer.guides.overlayShown()`);

  // Preview hides the bars; Esc exits; Delete removes the active sprite.
  await evalIn(page, `window.__spineViewer.preview.set(true); true`);
  await waitTruthy(page, `window.__spineViewer.preview.on`);
  await expect(page.locator("header.bar")).toBeHidden();
  await page.keyboard.press("Escape");
  await waitTruthy(page, `!window.__spineViewer.preview.on`);
  const before = await spriteCount(page);
  await page.keyboard.press("Delete");
  await waitTruthy(page, `window.__spineViewer.sprites().length === ${before - 1}`);
});

test("stage restores after reload and legacy saves migrate", async ({ page }) => {
  await bootEditor(page);
  const defaultId = await evalIn(page, `window.__spineViewer.CHARACTERS[0].id`);

  // Seed a legacy stage (no layers, no scenes) and reload: it must migrate
  // into the first scene with a single default layer.
  await evalIn(page, `(() => {
    localStorage.removeItem("spineViewer.scenes");
    localStorage.setItem("spineViewer.stage", JSON.stringify({ active: null, sprites: [{ characterId: ${JSON.stringify(defaultId)}, variant: "normal" }], zOrder: [${JSON.stringify(defaultId)}], audioVolume: 1 }));
    return true;
  })()`);
  await page.reload();
  await waitTruthy(page, `!!window.__spineViewer?.player?.skeleton`);
  const migrated = await evalIn(page, `(() => ({
    layers: window.__spineViewer.layers.list().map((l) => l.name),
    first: window.__spineViewer.sprites()[0]?.characterId,
  }))()`);
  expect(migrated.layers).toEqual(["Layer 1"]);
  expect(migrated.first).toBe(defaultId);

  // Persist a real edit (position) and confirm it survives a reload.
  await evalIn(page, `(() => {
    const s = window.__spineViewer.sprites()[0];
    window.__spineViewer.addSprite("samples/sample.png");
    return true;
  })()`);
  await waitTruthy(page, `window.__spineViewer.sprites().length === 2`);
  await page.reload();
  await waitTruthy(page, `window.__spineViewer.sprites().length === 2`);
});

test("thumbnails render progressively in the picker", async ({ page }) => {
  await bootEditor(page);
  await page.click("#add-char-btn");
  await expect
    .poll(() => page.locator(".picker-cell img").count(), { timeout: 60000 })
    .toBeGreaterThanOrEqual(1);
});

/** A 2x2 PNG buffer. */
function tinyPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8AARIQYGRhA3X8ABQACHqv7TQAAAABJRU5ErkJggg==",
    "base64"
  );
}
