/**
 * Spine playback semantics (Playwright migration, Phase 4): version dispatch,
 * variant loading + defaults, click/hold behaviour. Uses the two dev fixture
 * characters (the assets/c312 + c313 skeletons, which also exist in Nikke —
 * ids may be "c312"/"c313" or deduped to "c312-2"/"c313-2").
 */
import { test, expect } from "playwright/test";
import { bootEditor, evalIn, waitTruthy } from "./helpers.js";

/** Resolve the fixture ids from the live manifest (312 -> Spine 4.0, 313 -> 4.1). */
async function fixtureId(page, stem) {
  const ids = await evalIn(
    page,
    `window.__spineViewer.CHARACTERS.filter((c) => c.id === "c${stem}" || c.id.startsWith("c${stem}-")).map((c) => c.id)`
  );
  // Prefer the base name (Nikke copy), else the deduped assets copy.
  return ids.includes(`c${stem}`) ? `c${stem}` : ids[0];
}

const EXPECTED = { 312: { version: "4.0.47", anims: 9 }, 313: { version: "4.1.20", anims: 15 } };
const VARIANTS = { aim: 7, cover: 6 };

async function loadFixture(page, stem) {
  const id = await fixtureId(page, stem);
  expect(id, `fixture ${stem} present`).toBeTruthy();
  await evalIn(page, `window.__spineViewer.selectCharacter(${JSON.stringify(id)}); true`);
  await waitTruthy(
    page,
    `window.__spineViewer.player?.skeleton && window.__spineViewer.player.skeleton.data.version === ${JSON.stringify(EXPECTED[stem].version)}`
  );
  return id;
}

test("fixture versions and animation counts (4.0.x + 4.1.x)", async ({ page }) => {
  await bootEditor(page);
  await loadFixture(page, 313);
  expect(await evalIn(page, `window.__spineViewer.player.animationNames.length`)).toBe(EXPECTED[313].anims);
  await loadFixture(page, 312);
  expect(await evalIn(page, `window.__spineViewer.player.animationNames.length`)).toBe(EXPECTED[312].anims);
  expect(await evalIn(page, `window.__spineViewer.player.currentAnimation`)).toBe("idle");
});

test("variants load with their default click animations", async ({ page }) => {
  await bootEditor(page);
  const id = await loadFixture(page, 312);

  for (const [variant, anims, click] of [
    ["cover", VARIANTS.cover, "cover_reload"],
    ["aim", VARIANTS.aim, "aim_fire"],
  ]) {
    await page.selectOption("#variant-select", variant);
    await waitTruthy(page, `window.__spineViewer.player.animationNames.length === ${anims}`);
    expect(await evalIn(page, `document.getElementById("click-select").value`)).toBe(click);
  }
  // Back to normal for the remaining checks.
  await page.selectOption("#variant-select", "normal");
  await waitTruthy(page, `window.__spineViewer.player.animationNames.length === ${EXPECTED[312].anims}`);
  expect(id).toBeTruthy();
});

test("click/hold plays the click animation and returns to idle", async ({ page }) => {
  await bootEditor(page);
  await loadFixture(page, 312);

  // Default click for the normal variant is "action".
  expect(await evalIn(page, `document.getElementById("click-select").value`)).toBe("action");

  const state = () => evalIn(page, `(() => { const t = window.__spineViewer.player.state.tracks[0]; return { name: t.animation?.name ?? null, loop: t.loop }; })()`);

  // Press the sprite centre and hold: action must loop.
  await pressCenter(page, true);
  await page.waitForTimeout(300);
  expect(await state()).toMatchObject({ name: "action", loop: true });
  await page.waitForTimeout(900);
  expect((await state()).name).toBe("action");
  await release(page);
  // After release the instance finishes and the previous animation resumes.
  await page.waitForFunction(() => {
    const t = window.__spineViewer.player.state.tracks[0];
    return t.animation?.name === "idle";
  });
  expect((await state()).name).toBe("idle");

  // Pressing outside the sprite does nothing.
  await pressCorner(page);
  await page.waitForTimeout(250);
  await release(page);
  await page.waitForTimeout(150);
  expect((await state()).name).toBe("idle");

  // Setting the click to "none" disables the reaction.
  await page.selectOption("#click-select", "none");
  await pressCenter(page, true);
  await page.waitForTimeout(250);
  await release(page);
  await page.waitForTimeout(150);
  expect((await state()).name).toBe("idle");
});

async function pressCenter(page, hold = true) {
  await evalIn(page, `(() => {
    const c = window.__spineViewer.activeCanvas;
    const r = c.getBoundingClientRect();
    const p = window.__spineViewer.activeCenter;
    c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + p.x, clientY: r.top + p.y }));
    return true;
  })()`);
  if (!hold) await release(page);
}
async function pressCorner(page) {
  await evalIn(page, `(() => {
    const c = window.__spineViewer.activeCanvas;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, isPrimary: true, button: 0, buttons: 1, clientX: r.left + 4, clientY: r.top + 4 }));
    return true;
  })()`);
}
async function release(page) {
  await evalIn(page, `window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, buttons: 0, clientX: 0, clientY: 0 })); true`);
}
