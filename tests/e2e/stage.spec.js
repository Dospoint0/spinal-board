/**
 * Stage layout/cap + animation probes (Phase 4): sprites keep their own
 * explicit layout — adding/removing siblings never re-flows anything — ONE
 * shared canvas, the 30-sprite cap is enforced, GIF/video frames change, and
 * window resizes only scale sprites proportionally (no auto re-fit).
 */
import { test, expect } from "playwright/test";
import { bootEditor, evalIn, waitTruthy } from "./helpers.js";

test("adding or removing sprites never re-flows existing layouts", async ({ page }) => {
  await bootEditor(page);
  // The boot default sprite has been frozen into canvas fractions.
  await waitTruthy(
    page,
    `(() => { const c = window.__spineViewer.player.layoutConfig; return c && c.fw != null && c.fh != null; })()`
  );
  const snap = await evalIn(page, `window.__spineViewer.player.layoutConfig`);

  // Add two more sprites: the first one must NOT move or resize (no
  // equal-width re-flow); each new sprite is centred with its own fit.
  await evalIn(page, `window.__spineViewer.addSprite("c313-2"); true`);
  await evalIn(page, `window.__spineViewer.addSprite("samples/sample.png"); true`);
  await waitTruthy(page, `window.__spineViewer.sprites().length === 3`);
  await waitTruthy(page, `window.__spineViewer.players.every((p) => !!p.skeleton)`);
  await waitTruthy(
    page,
    `window.__spineViewer.players.every((p) => { const c = p.layoutConfig; return c && c.fw != null && c.fh != null; })`
  );

  const cfg = await evalIn(page, `window.__spineViewer.players.map((p) => p.layoutConfig)`);
  expect(cfg.length).toBe(3);
  expect(Math.abs(cfg[0].x - snap.x)).toBeLessThan(1e-9);
  expect(Math.abs(cfg[0].y - snap.y)).toBeLessThan(1e-9);
  expect(Math.abs(cfg[0].fw - snap.fw)).toBeLessThan(1e-9);
  expect(Math.abs(cfg[0].fh - snap.fh)).toBeLessThan(1e-9);
  // New sprites default to the canvas centre.
  for (const c of cfg) {
    expect(Math.abs((c.x ?? 0.5) - 0.5)).toBeLessThan(0.01);
    expect(Math.abs((c.y ?? 0.5) - 0.5)).toBeLessThan(0.01);
  }
  expect(await evalIn(page, `document.querySelectorAll("#stage canvas").length`)).toBe(1);
  const drawn = await evalIn(page, `(() => { const st = window.__spineViewer.stage; st.renderOnce(); return st.canvasPixels().drawn; })()`);
  expect(drawn).toBeGreaterThan(500);

  // Removing a sprite leaves the others untouched.
  await evalIn(page, `(() => {
    const s = window.__spineViewer.sprites().find((x) => x.characterId === "samples/sample.png");
    window.__spineViewer.removeSprite(s.id);
    return true;
  })()`);
  await waitTruthy(page, `window.__spineViewer.sprites().length === 2`);
  const cfg2 = await evalIn(page, `window.__spineViewer.players.map((p) => p.layoutConfig)`);
  expect(cfg2.length).toBe(2);
  expect(Math.abs(cfg2[0].x - snap.x)).toBeLessThan(1e-9);
  expect(Math.abs(cfg2[0].fw - snap.fw)).toBeLessThan(1e-9);
});

test("30-sprite cap is enforced", async ({ page }) => {
  await bootEditor(page);
  const info = await evalIn(page, `(() => {
    const CHAR = window.__spineViewer.CHARACTERS;
    const onStage = new Set(window.__spineViewer.sprites().map((s) => s.characterId));
    const ids = CHAR.filter((c) => !onStage.has(c.id)).map((c) => c.id);
    for (const id of ids) {
      if (window.__spineViewer.sprites().length >= 30) break;
      window.__spineViewer.addSprite(id);
    }
    const count = window.__spineViewer.sprites().length;
    const rejected = ids.length ? window.__spineViewer.addSprite(ids[0]) : null;
    return { count, rejectedNull: rejected === null };
  })()`);
  expect(info.count).toBe(30);
  expect(info.rejectedNull).toBe(true);

  await evalIn(page, `(() => { for (const s of window.__spineViewer.sprites()) window.__spineViewer.removeSprite(s.id); return true; })()`);
  await waitTruthy(page, `window.__spineViewer.sprites().length === 0`);
});

test("video and gif sprites animate (frames/signatures change)", async ({ page }) => {
  await bootEditor(page);

  // GIF: decode via gifuct, then advancing the frame clock moves gifIndex.
  await evalIn(page, `window.__spineViewer.selectCharacter("samples/sample.gif"); true`);
  await waitTruthy(page, `window.__spineViewer.player?.gifFrames && window.__spineViewer.player.gifFrames.length >= 2`);
  const gif = await evalIn(page, `(() => {
    const p = window.__spineViewer.player;
    const idx0 = p.gifIndex;
    p.gifTick(performance.now() + 400);
    return { frames: p.gifFrames.length, idx0, idx1: p.gifIndex };
  })()`);
  expect(gif.frames).toBeGreaterThanOrEqual(2);
  expect(gif.idx1).not.toBe(gif.idx0);

  // Video: rendering at two moments must produce different pixel signatures.
  await evalIn(page, `window.__spineViewer.selectCharacter("samples/sample.webm"); true`);
  await waitTruthy(page, `window.__spineViewer.player?.skeleton`);
  const sig = await evalIn(page, `(() => { const st = window.__spineViewer.stage; st.renderOnce(); return st.pixelSignature(); })()`);
  await page.waitForTimeout(600);
  const sig2 = await evalIn(page, `(() => { const st = window.__spineViewer.stage; st.renderOnce(); return st.pixelSignature(); })()`);
  expect(sig2).not.toBe(sig);
});

test("window resizes only scale sprites proportionally (no re-fit)", async ({ page }) => {
  await bootEditor(page);
  const before = await evalIn(page, `(() => {
    const c = window.__spineViewer.player;
    const cfg = c.layoutConfig;
    const cc = window.__spineViewer.activeCanvas;
    const r = c.modelRect(cc.clientWidth, cc.clientHeight);
    return { cfg: { x: cfg.x, y: cfg.y, fw: cfg.fw, fh: cfg.fh }, rectW: r ? r.right - r.left : null, clientW: cc.clientWidth };
  })()`);

  await page.setViewportSize({ width: 900, height: 1400 });
  await page.waitForTimeout(400);
  const after = await evalIn(page, `(() => {
    const c = window.__spineViewer.player;
    const cfg = c.layoutConfig;
    const cc = window.__spineViewer.activeCanvas;
    const r = c.modelRect(cc.clientWidth, cc.clientHeight);
    return { cfg: { x: cfg.x, y: cfg.y, fw: cfg.fw, fh: cfg.fh }, rectW: r ? r.right - r.left : null, clientW: cc.clientWidth };
  })()`);

  // Fractions (and therefore layout) are unchanged…
  expect(after.cfg.x).toBe(before.cfg.x);
  expect(after.cfg.y).toBe(before.cfg.y);
  expect(after.cfg.fw).toBe(before.cfg.fw);
  expect(after.cfg.fh).toBe(before.cfg.fh);
  // …and the on-screen rect scales with the canvas width (proportional).
  const ratio = after.clientW / before.clientW;
  expect(after.rectW / before.rectW).toBeCloseTo(ratio, 1);
  const drawn = await evalIn(page, `(() => { const st = window.__spineViewer.stage; st.renderOnce(); return st.canvasPixels().drawn; })()`);
  expect(drawn).toBeGreaterThan(500);
});
