/**
 * wallpaper.js — clean fullscreen renderer for the DEV/LIVE wallpaper page
 * (wallpaper.html in the repo). Exported packages ship the sibling static
 * entry instead (src/export-wallpaper.js -> dist/template-static/wallpaper.js),
 * which loads only the baked scene and never touches storage or the network.
 *
 * No UI: no buttons, no dropdowns, no scene-management panels. It renders the
 * designated scene into a full-viewport canvas and keeps the click/hold
 * "on_click" behaviour (click animation + voice line). It runs read-only
 * ({ persist: false }) so it never writes over the editor's saved scenes.
 *
 * Scene selection, in order of priority:
 *   1. URL query override (e.g. wallpaper.html?character=c312&variant=normal&
 *      animation=idle)
 *   2. the editor's CURRENT SCENE (localStorage "spineViewer.scenes")
 *   3. the legacy saved stage ("spineViewer.stage" + "spineViewer.bg")
 *   4. the first character in the manifest (default)
 */
import { createWallpaperScene, attachWallpaperInput } from "./wallpaper-core.js";
import { loadCharacters } from "./manifest-loader.js";

const CHARACTERS = await loadCharacters();
const { scene } = createWallpaperScene(CHARACTERS);

const params = new URLSearchParams(location.search);

// Global audio volume override.
if (params.has("volume")) {
  const v = Number(params.get("volume"));
  if (Number.isFinite(v)) scene.audioVolume = Math.min(1, Math.max(0, v / 100));
}

/** Read the editor's current scene (state + its background blob key). */
function readCurrentScene() {
  try {
    const raw = localStorage.getItem("spineViewer.scenes");
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.list) || !data.list.length) return null;
    const id =
      data.current && data.list.some((s) => s.id === data.current) ? data.current : data.list[0].id;
    const rec = data.list.find((s) => s.id === id);
    return rec && rec.state ? { state: rec.state, sceneId: id } : null;
  } catch {
    return null;
  }
}

/** Build per-sprite settings from URL params, or null if none are present. */
function buildUrlSettings(params) {
  const KEYS = [
    "characters", "character", "variant", "animation", "click", "speed",
    "loop", "bg", "bgcolor", "mute", "volume", "scale", "opacity", "tint", "mirror",
  ];
  if (!KEYS.some((k) => params.has(k))) return null;

  let ids = [];
  if (params.get("characters")) {
    ids = params.get("characters").split(",").map((s) => s.trim()).filter(Boolean);
  } else if (params.get("character")) {
    ids = [params.get("character").trim()];
  }
  if (!ids.length && CHARACTERS.length) ids = [CHARACTERS[0].id];

  const variant = params.get("variant") || "normal";
  const animation = params.get("animation") || null;
  const click = params.has("click") ? params.get("click") : null;
  const speed = params.has("speed") ? Number(params.get("speed")) : null;
  const loop = params.has("loop") ? params.get("loop") !== "0" : null;
  const scale = params.has("scale") ? Number(params.get("scale")) : null;
  const opacity = params.has("opacity") ? Number(params.get("opacity")) : null;
  const tint = params.get("tint") || null;
  const muted = params.has("mute") ? params.get("mute") !== "0" : null;
  const mirror = params.has("mirror") ? params.get("mirror") !== "0" : null;

  return ids.slice(0, 30).map((characterId) => {
    const s = { characterId, variant };
    if (animation != null) s.animation = animation;
    if (click != null) s.clickAnimation = click;
    if (speed != null && Number.isFinite(speed)) s.speed = speed;
    if (loop != null) s.loop = loop;
    if (scale != null && Number.isFinite(scale)) s.scale = scale;
    if (opacity != null && Number.isFinite(opacity)) s.opacity = Math.min(1, Math.max(0, opacity));
    if (tint) s.tint = tint;
    if (muted != null) s.muted = muted;
    if (mirror != null) s.mirror = mirror;
    return s;
  });
}

/** Apply a background from URL params; returns false if none were given. */
function applyBackgroundOverride(params) {
  if (!params.has("bg") && !params.has("bgcolor")) return false;
  const raw = (params.get("bg") ?? params.get("bgcolor") ?? "").trim();
  if (!raw || raw === "transparent" || raw === "none") {
    scene.bgMode = "transparent";
    scene.bgColor = "#000000";
  } else {
    scene.bgMode = "custom";
    scene.bgColor = raw.startsWith("#") ? raw : `#${raw}`;
  }
  scene.applyBackground();
  return true;
}

async function runLive() {
  const urlSettings = buildUrlSettings(params);
  if (urlSettings) {
    for (const s of urlSettings) scene.addSprite(s.characterId, { activate: false, settings: s });
    if (!applyBackgroundOverride(params)) scene.restoreBg();
    return;
  }
  const current = readCurrentScene();
  if (current && current.state && Array.isArray(current.state.sprites) && current.state.sprites.length) {
    scene.bgDbKey = current.sceneId;
    await scene.applyState(current.state, { bgBlobKey: current.sceneId });
    return;
  }
  if (!applyBackgroundOverride(params)) scene.restoreBg();
  if (!scene.restoreStage() && CHARACTERS.length) {
    scene.addSprite(CHARACTERS[0].id, { activate: false });
  }
}

await runLive();
attachWallpaperInput({ canvas: document.getElementById("stage-canvas"), scene });
