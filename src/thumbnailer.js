/**
 * Thumbnailer — renders character preview images for the picker window.
 *
 * Each preview is a real render of the character's normal variant, produced
 * on a single shared hidden WebGL canvas using the same SpinePlayer pipeline
 * (load → fit → render → capture), then cached as a PNG data URL so opening
 * the picker again is instant.
 *
 * Jobs run sequentially (a single GL context is shared) and progressively —
 * the picker grid fills in as thumbnails complete. Failed characters are
 * cached as null so they are not retried.
 */
import { SpinePlayer } from "./spine-player.js";
import { defaultVariant } from "./scene.js";

const THUMB_W = 256;
const THUMB_H = 320;

export class Thumbnailer {
  /**
   * @param {Map<string, object>} charactersById manifest entries by id
   * @param {(done:number, total:number)=>void} [onProgress]
   * @param {(id:string, url:string|null)=>void} [onThumbnail] called after each render
   */
  constructor(charactersById, onProgress = null, onThumbnail = null) {
    this.charactersById = charactersById;
    this.onProgress = onProgress;
    this.onThumbnail = onThumbnail;
    this.cache = new Map(); // id -> dataURL | null
    this.queue = [];
    this.running = false;
    this.canvas = null;
    this.player = null;
  }

  /** Number of characters still pending (including in-flight). */
  get pendingCount() {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** @returns {string|null|undefined} cached URL, null = failed, undefined = not rendered */
  get(id) {
    return this.cache.has(id) ? this.cache.get(id) : undefined;
  }

  /** @returns {Promise<string|null>} resolves when this id is rendered (or failed) */
  async render(id) {
    const cached = this.get(id);
    if (cached !== undefined) return cached;
    this.queue.push(id);
    await this.drain();
    return this.get(id);
  }

  /**
   * Queue many ids; rendering starts immediately and continues in order.
   * @param {Array<string>} ids
   * @param {{priority?: boolean}} [opts] priority:true prepends so these render
   *   before the already-queued characters (used when switching picker tabs).
   */
  enqueue(ids, { priority = false } = {}) {
    for (const id of ids) {
      if (this.cache.has(id) || this.queue.includes(id)) continue;
      if (priority) this.queue.unshift(id);
      else this.queue.push(id);
    }
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        const char = this.charactersById.get(id);
        const url = await this._renderOne(id, char);
        if (this.onThumbnail) this.onThumbnail(id, url);
        if (this.onProgress) this.onProgress(this.cache.size, this.cache.size + this.queue.length);
      }
    } finally {
      this.running = false;
    }
  }

  async _renderOne(id, char) {
    try {
      // Spine items may not have a "normal" variant (e.g. loose-skeleton
      // folders) — fall back to the character's default variant.
      const variantName = char && char.variants ? defaultVariant(char) : null;
      const entry = char && char.variants ? char.variants[variantName] : null;
      if (!entry) {
        this.cache.set(id, null);
        return null;
      }
      this._ensureCanvas();
      await this.player.load(entry);
      this.player._render(); // draw one frame into the buffer
      const url = this.canvas.toDataURL("image/png");
      this.cache.set(id, url);
      this.player._disposeModel(); // stop loop + free textures for the next job
      return url;
    } catch (err) {
      console.warn(`[Thumbnailer] ${id}: ${err.message}`);
      if (this.player) this.player._disposeModel();
      this.cache.set(id, null);
      return null;
    }
  }

  _ensureCanvas() {
    if (this.canvas) return;
    this.canvas = document.createElement("canvas");
    this.canvas.width = THUMB_W;
    this.canvas.height = THUMB_H;
    this.canvas.style.width = `${THUMB_W}px`;
    this.canvas.style.height = `${THUMB_H}px`;
    // Hidden but laid out (fixed, off-screen) so clientWidth/Height are real.
    this.canvas.style.position = "fixed";
    this.canvas.style.left = "-10000px";
    this.canvas.style.top = "0";
    this.canvas.style.zIndex = "-1";
    document.body.appendChild(this.canvas);
    this.player = new SpinePlayer(this.canvas);
  }
}
