/**
 * sprite-adapters.js — the SpriteAdapter layer.
 *
 * Classifies manifest entries and loads them into the shared SpineModel
 * pipeline. Every adapter produces a uniform renderable model (a skeleton,
 * or a single-region "skeleton" around an image / GIF canvas / video), so the
 * StageRenderer, hit-testing, colour/transform handling and the editor UI
 * need no per-kind code — the adapter is the only extension point when a new
 * sprite media kind is added.
 *
 * Kind map (see the project brief):
 *   spine  — Spine .skel (4.0.x / 4.1.x), dispatched by runtime-loader
 *   image  — PNG/JPEG/WebP (animated WebP shows its first frame)
 *   video  — WebM/MP4, looped via a muted <video> element
 *   gif    — animated GIF, decoded by gifuct-js and played on a canvas
 *   live2d — (reserved, NOT implemented) Cubism 3/4/5 once the user places
 *            their licensed runtime in vendor/cubism/ — never shipped.
 *
 * Character-centric scenes (characterId + variant) remain the persisted unit;
 * the adapters operate underneath that model.
 */

/** Kinds that render from a plain asset URL (no variant/skeleton files). */
const URL_KINDS = new Set(["image", "video", "gif", "live2d"]);

/** Adapters by kind. `live2d` loads a .model3.json model through the
 *  user-provided Cubism runtime (degrading when it is absent). */
export const SpriteAdapters = {
  image: {
    kind: "image",
    load(model, url) {
      return model.loadImageAsset(url);
    },
  },
  video: {
    kind: "video",
    load(model, url) {
      return model.loadVideoAsset(url);
    },
  },
  gif: {
    kind: "gif",
    load(model, url) {
      return model.loadGifAsset(url);
    },
  },
  live2d: {
    kind: "live2d",
    load(model, url) {
      return model.loadLive2DAsset(url);
    },
  },
};

/** Sprite kind for a manifest character: URL-only entries carry their kind on
 *  the record; everything else (standard characters and custom .skel) is a
 *  spine sprite. */
export function classifyCharacter(character) {
  if (!character) return "spine";
  if (URL_KINDS.has(character.kind)) return character.kind;
  return "spine";
}

/** Adapter for a sprite kind, or null when not implemented. */
export function adapterForKind(kind) {
  return SpriteAdapters[kind] ?? null;
}

/** Load a media asset (image/gif/video) into a model through its adapter.
 *  Returns the adapter's promise; spine loading is handled by the caller
 *  (it needs the variant entry). */
export function loadSpriteMedia(model, kind, url) {
  const adapter = adapterForKind(kind);
  if (!adapter || !adapter.load || typeof url !== "string") {
    return Promise.resolve();
  }
  return adapter.load(model, url);
}
