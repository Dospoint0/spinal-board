/**
 * Editor basics (Playwright migration, Phase 4).
 *
 * Covers the core flows the interim BiDi harness guards: boot/panel/picker,
 * media sprites, playback controls, edit mode + shortcuts + preview, scene &
 * layer persistence, and audio snippets. The fine-grained version/animation
 * assertions stay in the interim harness until parity is complete.
 */
import { test, expect } from "playwright/test";
import { bootEditor, evalIn, pickerClick, renderedPixels, spriteCount, waitTruthy, waitLoad } from "./helpers.js";

test("boots a spine character with the settings panel", async ({ page }) => {
  await bootEditor(page);
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#panel-content")).toBeVisible();
  await expect(page.locator("#variant-select")).toHaveValue(/./);
  expect(await spriteCount(page)).toBeGreaterThanOrEqual(1);
  const drawn = await renderedPixels(page);
  expect(drawn).toBeGreaterThan(500);
});

test("picker: search, media subtab, image/video/gif sprites", async ({ page }) => {
  await bootEditor(page);
  await page.click("#add-char-btn");
  await expect(page.locator("#picker")).toBeVisible();

  // Default tab is the first alphabetical library tab ("assets"); searching
  // for "313" must narrow the visible cells to the single assets c313 entry.
  await page.fill("#picker-search", "313");
  await expect
    .poll(() => page.locator('.picker-cell:not([style*="display: none"])').count())
    .toBeGreaterThanOrEqual(1);
  expect(await page.locator('.picker-cell:not([style*="display: none"])').count()).toBe(1);
  await page.fill("#picker-search", "");

  // custom_assets tab: one subtab ("Samples") with image/video/gif cells.
  await page.click('#picker-tabs [data-tab="custom_assets"]');
  await expect(page.locator("#picker-subtabs .picker-tab")).toContainText(["Samples"]);
  await pickerClick(page, "samples/sample.png");
  // The picker add activates the new sprite; wait for its model to load.
  await waitTruthy(page, `window.__spineViewer.player?.skeleton`);
  expect(await evalIn(page, `window.__spineViewer.sprites().find(s=>s.characterId==="samples/sample.png").kind`)).toBe("image");
  expect(await renderedPixels(page)).toBeGreaterThan(500);
});

test("playback controls: pause, restart, speed, loop", async ({ page }) => {
  await bootEditor(page);
  const paused = () => evalIn(page, `window.__spineViewer.player.paused`);
  await page.click("#play-pause-btn");
  expect(await paused()).toBe(true);
  await page.click("#play-pause-btn");
  expect(await paused()).toBe(false);
  await page.click("#restart-btn");
  await page.selectOption("#speed-select", "2");
  await page.waitForFunction(() => window.__spineViewer.player.state.timeScale === 2);
  await page.locator("#loop-check").uncheck();
  await page.waitForFunction(() => window.__spineViewer.player.state.tracks[0].loop === false);
});

test("edit mode, keyboard shortcuts and preview", async ({ page }) => {
  await bootEditor(page);

  // E toggles edit mode + overlays.
  await page.keyboard.press("KeyE");
  await expect(page.locator(".edit-overlay").first()).toBeVisible();
  await page.keyboard.press("KeyE");
  await expect(page.locator(".edit-overlay")).toHaveCount(0);

  // F enters preview and leaves edit mode; E is inert while picker is open.
  await page.keyboard.press("KeyE");
  await page.keyboard.press("KeyF");
  await expect(page.locator("body")).toHaveClass(/preview/);
  expect(await evalIn(page, `document.getElementById("edit-btn").classList.contains("active")`)).toBe(false);
  await page.keyboard.press("KeyF");
  await expect(page.locator("body")).not.toHaveClass(/preview/);

  // A opens the picker and does not type into its search field.
  await page.keyboard.press("KeyA");
  await expect(page.locator("#picker")).toBeVisible();
  expect(await evalIn(page, `document.getElementById("picker-search").value`)).toBe("");
  await page.keyboard.press("Escape");
  await expect(page.locator("#picker")).toBeHidden();
});

test("scenes and layers persist across reload", async ({ page }) => {
  await bootEditor(page);
  // Add a second sprite + a layer, then reload.
  await evalIn(page, `window.__spineViewer.addSprite("samples/sample.png"); true`);
  await waitTruthy(page, `window.__spineViewer.sprites().length >= 2`);
  await evalIn(page, `window.__spineViewer.layers.add("FG"); true`);
  await page.reload();
  await waitTruthy(page, `!!window.__spineViewer && window.__spineViewer.player?.skeleton`);
  expect(await evalIn(page, `window.__spineViewer.sprites().length`)).toBeGreaterThanOrEqual(2);
  const layers = await evalIn(page, `window.__spineViewer.layers.list().map(l=>l.name)`);
  expect(layers).toContain("FG");
});

test("audio: upload custom audio, click plays it, snippet honors start", async ({ page }) => {
  await bootEditor(page);
  await evalIn(page, `window.__spineViewer.addSprite("samples/sample.png"); true`);
  await waitTruthy(page, `window.__spineViewer.player?.skeleton`);

  // Build a tiny WAV and upload it through the panel input. The server names
  // the file after the asset (sample.wav), regardless of the chosen name.
  await page.setInputFiles("#audio-upload", {
    name: "voice.wav",
    mimeType: "audio/wav",
    buffer: wavBuffer(),
  });
  await expect(page.locator("#audio-custom .audio-name")).toHaveText("sample.wav");

  // Spy on Audio; clicking the sprite must construct one for the uploaded file.
  await evalIn(page, `(() => { window.__spy = []; window.Audio = class { constructor(url){ this.url=url; this.volume=1; window.__spy.push(this);} play(){ return Promise.resolve(); } pause(){} }; return true; })()`);
  await clickActiveCenter(page);
  await page.waitForTimeout(300);
  const urls = await evalIn(page, `window.__spy.map(a=>a.url)`);
  expect(urls.some((u) => u.endsWith("sample.wav"))).toBe(true);

  // Snippet: trim 0.1–0.4s and verify a press starts at 0.1s.
  await evalIn(
    page,
    `window.__spineViewer.setAudioSnippet(window.__spineViewer.activeId, { name: "sample.wav", file: "custom_assets/samples/sample.wav", start: 0.1, end: 0.4 }); true`
  );
  await evalIn(page, `(() => { window.__spy = []; window.Audio = class { constructor(url){ this.url=url; this.currentTime=0; this.duration=1; this._l={}; this._fired=false; window.__spy.push(this);} addEventListener(t,cb){ (this._l[t]=this._l[t]||[]).push(cb);} play(){ if(!this._fired){ this._fired=true; (this._l.loadedmetadata||[]).forEach(f=>f()); (this._l.canplay||[]).forEach(f=>f()); } return Promise.resolve(); } pause(){} }; return true; })()`);
  await clickActiveCenter(page);
  await page.waitForTimeout(300);
  const last = await evalIn(page, `(() => { const a = window.__spy[window.__spy.length-1]; return a ? { url: a.url, t: a.currentTime } : null; })()`);
  expect(last).not.toBeNull();
  expect(last.url.endsWith("sample.wav")).toBe(true);
  expect(Math.abs(last.t - 0.1)).toBeLessThan(0.001);

  // Cleanup: remove the uploaded file from the asset folder (and the sprite).
  await page.click("#audio-custom .audio-remove");
  await expect(page.locator("#audio-custom .audio-item")).toHaveCount(0);
  await evalIn(page, `window.__spineViewer.removeSprite(window.__spineViewer.activeId); true`);
});

async function clickActiveCenter(page) {
  await evalIn(page, `(() => {
    const c = window.__spineViewer.activeCanvas;
    const r = c.getBoundingClientRect();
    const p = window.__spineViewer.activeCenter;
    c.dispatchEvent(new PointerEvent("pointerdown", { bubbles:true, pointerId:1, isPrimary:true, button:0, buttons:1, clientX:r.left+p.x, clientY:r.top+p.y }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles:true, pointerId:1, button:0, buttons:0, clientX:r.left+p.x, clientY:r.top+p.y }));
    return true;
  })()`);
}

/** 8000 Hz, 0.5s mono 16-bit WAV with a rising tone. */
function wavBuffer() {
  const seconds = 0.5;
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, buf.byteLength - 8, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin((i / n) * Math.PI * 4) * 4000), true);
  return Buffer.from(buf);
}
