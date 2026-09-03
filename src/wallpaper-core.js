/**
 * wallpaper-core.js — shared boot helpers for the two wallpaper entries:
 *
 *   src/wallpaper.js          dev/live template (URL override / saved scenes)
 *   src/export-wallpaper.js   static runtime for exported packages (baked
 *                             #lwpg-scene JSON only; no storage or network)
 *
 * Both run read-only ({ persist: false }) on the same SceneController core.
 */
import { SceneController, defaultClickAnimation } from "./scene.js";

/** The #stage / #stage-canvas elements every wallpaper page provides. */
export function canvasAndStage() {
  return {
    canvas: document.getElementById("stage-canvas"),
    stage: document.getElementById("stage"),
  };
}

/** Baked scene for exported packages (inline JSON in wallpaper.html). */
export function readBakedScene() {
  try {
    const el = document.getElementById("lwpg-scene");
    if (!el) return null;
    const baked = JSON.parse(el.textContent);
    if (baked && Array.isArray(baked.characters) && baked.state) return baked;
  } catch (err) {
    console.warn("cannot read baked scene:", err);
  }
  return null;
}

/** Build the headless scene controller + the shared click fallback wiring. */
export function createWallpaperScene(characters, options = {}) {
  const { canvas, stage } = canvasAndStage();
  const scene = new SceneController(canvas, stage, characters, {
    persist: false,
    audioNoDb: options.audioNoDb === true,
  });
  // A sprite without an explicit click animation falls back to its default:
  // Spine uses the variant default (normal -> action, aim -> aim_fire, cover ->
  // cover_reload); Live2D uses the model's inferred reaction motion (e.g. a
  // touch-named motion or a TapBody group).
  scene.on("animationsChanged", (sprite, names) => {
    if (sprite.clickAnimation == null) {
      if (sprite.kind === "live2d") {
        const d = sprite.model.live2d?.defaultClickName;
        sprite.clickAnimation = d && names.includes(d) ? d : "none";
      } else {
        sprite.clickAnimation = defaultClickAnimation(sprite.variant, names);
      }
    }
  });
  return { canvas, stage, scene };
}

/** Apply a baked/exported state (background is a packaged file when present). */
export async function applyBakedScene(scene, baked) {
  await scene.applyState(baked.state, { loadBgBlob: false, bgBlobKey: null });
}

/** Click/hold interaction + fullscreen refit (shared by both entries). */
export function attachWallpaperInput({ canvas, scene }) {
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const sprite = scene.spriteAtPoint(ev.clientX - rect.left, ev.clientY - rect.top);
    if (sprite) scene.pressSprite(sprite);
  });
  const release = () => scene.releaseSprite();
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);

  const fit = () => scene.stageRenderer.resize();
  window.addEventListener("resize", fit);
  new ResizeObserver(fit).observe(scene.stage);
  requestAnimationFrame(fit);
}

/** Tiny probe handle for automated tests of exported packages (harmless in
 *  production): becomes "ready" after the first post-boot frame. */
export function exposeReadyProbe(scene) {
  window.__lwpg = { ready: false, stage: scene.stageRenderer };
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.__lwpg.ready = true;
    });
  });
}
