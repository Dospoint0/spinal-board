/**
 * export-wallpaper.js — the STATIC wallpaper runtime shipped inside every
 * exported package (built as dist/template-static/wallpaper.js).
 *
 * It intentionally imports NONE of the live/dev machinery: no manifest loader
 * (no bundled manifest fallback), no localStorage/IndexedDB, no URL-override
 * code. The scene was baked into wallpaper.html as inline JSON (#lwpg-scene)
 * by the exporter and is simply applied:
 *
 *   baked.characters  the packaged character registry (relative file URLs)
 *   baked.state       sprites/layers/background/volume, paths already remapped
 *
 * Live2D is not a supported feature: Cubism sprites degrade to placeholders
 * unless the user supplies their licensed runtime into cubism/ (the exporter
 * never includes it).
 */
import {
  createWallpaperScene,
  readBakedScene,
  applyBakedScene,
  attachWallpaperInput,
  exposeReadyProbe,
} from "./wallpaper-core.js";

const baked = readBakedScene();
if (!baked) {
  // Not an exported page (e.g. opened directly) — nothing to render.
  console.warn("exported wallpaper: no baked #lwpg-scene found");
} else {
  const { scene } = createWallpaperScene(baked.characters, { audioNoDb: true });
  await applyBakedScene(scene, baked);
  attachWallpaperInput({ canvas: document.getElementById("stage-canvas"), scene });
  exposeReadyProbe(scene);
}
