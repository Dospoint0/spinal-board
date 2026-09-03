/**
 * scene.js — shared scene runtime for the Spine viewer.
 *
 * SceneController owns everything that is NOT user interface:
 *   - the shared StageRenderer (many SpineModels on one canvas)
 *   - the sprite records (character, variant, animation, click animation,
 *     speed, loop, pause, position, scale, opacity, tint, brightness/RGB,
 *     audio)
 *   - persistence of the current stage (localStorage "spineViewer.stage")
 *   - persistence of the background (localStorage "spineViewer.bg" + IndexedDB)
 *   - the audio catalog + per-sprite voice-line playback
 *   - the click/hold "on_click" behaviour (press → click animation + voice)
 *
 * Both entry points use this class:
 *   - the editor (src/main.js) drives the UI and subscribes to the events
 *     below to keep its controls in sync;
 *   - the wallpaper (src/wallpaper.js) uses it headless — no UI, only the
 *     render + click behaviour — and constructs it with { persist: false } so
 *     it never writes over the editor's saved scene.
 *
 * Events emitted (subscribe with `on`): status, animationsChanged,
 * settingsApplied, spriteAdded, spriteRemoved, activeChanged, audioReady,
 * editsReset, bgChanged.
 */
import { SpineModel, StageRenderer } from "./spine-player.js";
import { AudioCatalog } from "./audio.js";
import { classifyCharacter, loadSpriteMedia } from "./sprite-adapters.js";

export const MAX_SPRITES = 30;

/** Per-variant default "click" (hold-to-play) animation. */
export const CLICK_DEFAULTS = {
  normal: ["action"],
  aim: ["aim_fire"],
  cover: ["cover_reload", "reload"],
};

/** Variant-aware default click animation, or "none" if none exists. */
export function defaultClickAnimation(variant, names) {
  const preferred = CLICK_DEFAULTS[variant] ?? CLICK_DEFAULTS.normal;
  return preferred.find((n) => names.includes(n)) ?? "none";
}

/** Default variant for a character: "normal" when present, else the first. */
export function defaultVariant(character) {
  if (!character || !character.variants) return "normal";
  if (character.variants.normal) return "normal";
  const keys = Object.keys(character.variants);
  return keys.length ? keys[0] : "normal";
}

const STAGE_KEY = "spineViewer.stage";
const BG_KEY = "spineViewer.bg";
const BG_DB = "spine-viewer-bg";
const BG_DB_STORE = "images";
const BG_DB_KEY = "current";

export class SceneController {
  /**
   * @param {HTMLCanvasElement} canvas the shared stage canvas
   * @param {HTMLElement} stageEl element that receives the background style
   * @param {Array} characters manifest entries (from loadCharacters())
   * @param {{persist?: boolean}} [options] set persist:false for read-only use
   */
  constructor(canvas, stageEl, characters, options = {}) {
    this.canvas = canvas;
    this.stage = stageEl;
    this.characters = characters;
    this.charactersById = new Map(characters.map((c) => [c.id, c]));
    this.stageRenderer = new StageRenderer(canvas);
    this.audioCatalog = new AudioCatalog(this.charactersById, { noIdb: options.audioNoDb === true });
    this.persist = options.persist !== false;

    this.audioVolume = 1; // 0..1, global
    this.sprites = new Map(); // id -> sprite record
    this.activeSpriteId = null;
    this.spriteSeq = 0;
    this.holdingSprite = null; // sprite with an active click animation

    // Background state: "transparent" | "#hex" | "custom" | "image".
    this.bgMode = "transparent";
    this.bgColor = "#000000";
    this.bgImageUrl = null; // object URL of the applied image/video
    this.bgImageBlob = null; // the applied blob (kept for scene saves)
    this.bgIsVideo = false; // true when the applied blob is a video (webm)
    this.bgVideoEl = null; // <video class="bg-video"> behind the canvas, if any
    /** IndexedDB key under which the current background blob is stored.
     *  Scenes set this to their own scene id (see applyState / main.js). */
    this.bgDbKey = options.bgDbKey || BG_DB_KEY;

    // Layers: bottom→top stack. Every sprite belongs to one layer; within a
    // layer sprites follow the last-moved-on-top rule (see StageRenderer).
    this.layers = [{ id: "layer-1", name: "Layer 1" }];

    /** Called with captureStage() every time the stage is persisted (the
     *  editor wires this to keep its current scene record up to date). */
    this.onPersist = null;

    this._listeners = new Map();
  }

  /* ------------------------------------------------------------------ *
   * Event helpers
   * ------------------------------------------------------------------ */

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
    return () => this.off(event, cb);
  }

  off(event, cb) {
    const cbs = this._listeners.get(event);
    if (!cbs) return;
    this._listeners.set(event, cbs.filter((fn) => fn !== cb));
  }

  emit(event, ...args) {
    const cbs = this._listeners.get(event);
    if (cbs) for (const cb of cbs.slice()) cb(...args);
  }

  /* ------------------------------------------------------------------ *
   * Sprite access
   * ------------------------------------------------------------------ */

  getActiveSprite() {
    return this.sprites.get(this.activeSpriteId) ?? null;
  }

  getActivePlayer() {
    return this.getActiveSprite()?.model ?? null;
  }

  findSpriteByModel(model) {
    for (const s of this.sprites.values()) {
      if (s.model === model) return s;
    }
    return null;
  }

  /** Topmost sprite under a canvas-relative CSS-pixel point, or null. */
  spriteAtPoint(x, y) {
    const model = this.stageRenderer.hitTest(x, y);
    return model ? this.findSpriteByModel(model) : null;
  }

  /* ------------------------------------------------------------------ *
   * Sprites: add / remove / activate
   * ------------------------------------------------------------------ */

  /** Add a character (or custom image/video asset) to the stage as a new
   *  sprite (and activate it). Returns the sprite, or null on failure. */
  addSprite(characterId, opts = {}) {
    if (this.sprites.size >= MAX_SPRITES) return null;
    const character = this.charactersById.get(characterId);
    if (!character) return null;

    const settings = opts.settings || null;
    // Media custom assets (image/gif/video) keep their own kind; everything
    // else (including custom .skel) is a spine character. See sprite-adapters.
    const kind = classifyCharacter(character);
    const id = `sprite-${++this.spriteSeq}`;
    const model = new SpineModel();
    const sprite = {
      id,
      model,
      characterId,
      kind,
      variant:
        kind === "spine"
          ? settings && character.variants[settings.variant]
            ? settings.variant
            : defaultVariant(character)
          : "main",
      // Spine + Live2D sprites support a click/hold reaction animation; media
      // sprites (image/gif/video) have none.
      clickAnimation:
        (kind === "spine" || kind === "live2d") && settings
          ? (settings.clickAnimation ?? null)
          : null,
      opacity: settings && typeof settings.opacity === "number" ? settings.opacity : 1,
      tint: settings ? settings.tint ?? "#ffffff" : "#ffffff",
      /** Colour balance: overall brightness (0..2) and per-channel RGB
       *  multipliers (0..2). Multiplied onto the tint on the model. */
      brightness: settings && typeof settings.brightness === "number" ? settings.brightness : 1,
      rgb: {
        r: settings && settings.rgb && typeof settings.rgb.r === "number" ? settings.rgb.r : 1,
        g: settings && settings.rgb && typeof settings.rgb.g === "number" ? settings.rgb.g : 1,
        b: settings && settings.rgb && typeof settings.rgb.b === "number" ? settings.rgb.b : 1,
      },
      audioEntry: null,
      audioCategories: new Set(),
      savedAudioCategories:
        settings && Array.isArray(settings.audioCategories) ? settings.audioCategories : null,
      /** Audio snippet { file?, name, start, end } — play only this segment
       *  (seconds) of one of the sprite's audio files on press; null = play
       *  the element's audio normally. `file` is the relative path for
       *  manifest-backed files (stable across reloads); `name` identifies the
       *  audio line when blob-backed (IndexedDB uploads) URLs are rebuilt. */
      audioSnippet:
        settings && settings.audioSnippet && typeof settings.audioSnippet === "object"
          ? {
              file: settings.audioSnippet.file ?? null,
              name: settings.audioSnippet.name ?? null,
              start: Number(settings.audioSnippet.start) || 0,
              end: settings.audioSnippet.end != null ? Number(settings.audioSnippet.end) : null,
            }
          : null,
      muted: settings ? !!settings.muted : false,
      audio: null, // currently playing Audio, if any
      layer: settings && this.layers.some((l) => l.id === settings.layer)
        ? settings.layer
        : (this.layers[0]?.id ?? "layer-1"),
      statusText: "",
      settings,
    };
    // Edit layout (position is a fraction of the canvas). Every sprite ends
    // up with an explicit x/y/fw/fh (the stage freezes a default centred fit
    // into fractions the first time it is laid out); sprites never auto
    // re-flow into an equal-width row.
    model.layoutConfig = {
      x: settings && settings.x != null ? settings.x : null,
      y: settings && settings.y != null ? settings.y : null,
      scale: settings && typeof settings.scale === "number" ? settings.scale : 1,
      fw: settings && typeof settings.fw === "number" ? settings.fw : null,
      fh: settings && typeof settings.fh === "number" ? settings.fh : null,
    };
    model.mirror = settings ? !!settings.mirror : false;
    model.layer = sprite.layer;
    this.sprites.set(id, sprite);
    this.stageRenderer.addModel(model);
    // Keep the draw order grouped by layer (a sprite in a lower layer must
    // never draw above a sprite in a higher layer).
    this.stageRenderer.applyLayerOrder(this.layers.map((l) => l.id));

    model.onStatus = (msg) => {
      sprite.statusText = msg;
      this.emit("status", sprite, msg);
    };
    model.onAnimationsChanged = (names, selected) => {
      this.emit("animationsChanged", sprite, names, selected);
      // Apply saved playback settings once, after the first load. Live2D
      // sprites share the animation/click/pause handling (their motion files
      // are exposed as animations); speed/loop are Spine-only.
      if (sprite.settings) {
        const st = sprite.settings;
        sprite.settings = null;
        if (kind === "spine" || kind === "live2d") {
          if (st.animation && names.includes(st.animation)) {
            model.setAnimation(st.animation, st.loop !== false);
          }
          if (kind === "spine") {
            if (typeof st.speed === "number") model.setSpeed(st.speed);
            model.setLoop(st.loop !== false);
          }
          if (
            st.clickAnimation != null &&
            (st.clickAnimation === "none" || names.includes(st.clickAnimation))
          ) {
            sprite.clickAnimation = st.clickAnimation;
          }
          if (st.paused) model.togglePause();
        }
        this.applySpriteColor(sprite);
        this.emit("settingsApplied", sprite);
      }
      this.stageRenderer.resize(); // bounds are ready — position the sprite
    };

    this.emit("spriteAdded", sprite);
    if (opts.activate !== false) this.activateSprite(id);
    this.loadSprite(sprite);
    if (kind === "spine") this.loadSpriteAudio(sprite);
    this.persistStage();
    return sprite;
  }

  removeSprite(id) {
    const sprite = this.sprites.get(id);
    if (!sprite) return;
    // Revoke object URLs of IndexedDB audio uploads.
    for (const line of sprite.audioEntry?.custom || []) {
      if (line.idb && line.url) {
        try {
          URL.revokeObjectURL(line.url);
        } catch {}
      }
    }
    this.stageRenderer.removeModel(sprite.model);
    this.stageRenderer.applyLayerOrder(this.layers.map((l) => l.id));
    this.sprites.delete(id);
    if (this.activeSpriteId === id) this.activeSpriteId = null;
    this.emit("spriteRemoved", sprite);
    if (this.activeSpriteId) {
      // Another sprite is still active — nothing to resync (already current).
      this.activateSprite(this.activeSpriteId);
    } else {
      const first = this.sprites.keys().next().value;
      if (first) this.activateSprite(first);
      else this.emit("activeChanged", null);
    }
    this.persistStage();
  }

  activateSprite(id) {
    if (!this.sprites.has(id)) return;
    if (this.activeSpriteId === id) return; // already active — nothing to resync
    this.activeSpriteId = id;
    this.emit("activeChanged", this.getActiveSprite());
  }

  async loadSprite(sprite) {
    // Media custom assets load through their kind's adapter; spine sprites
    // load a skeleton via the character's variant entry.
    const kind = classifyCharacter(this.charactersById.get(sprite.characterId));
    if (kind !== "spine") {
      const entry = this.charactersById.get(sprite.characterId);
      if (!entry || !entry.url) return;
      try {
        await loadSpriteMedia(sprite.model, kind, entry.url);
        this.stageRenderer.resize();
      } catch {
        // player.load already surfaced the error via onStatus.
      }
      return;
    }
    const character = this.charactersById.get(sprite.characterId);
    const entry = character?.variants?.[sprite.variant];
    if (!entry) {
      sprite.model.onStatus(`Variant "${sprite.variant}" is not available for ${sprite.characterId}.`);
      sprite.model.onAnimationsChanged([], null);
      return;
    }
    try {
      await sprite.model.load(entry);
      this.stageRenderer.resize();
    } catch {
      // player.load already surfaced the error via onStatus.
    }
  }

  /* ------------------------------------------------------------------ *
   * Audio (matched voice lines per sprite)
   * ------------------------------------------------------------------ */

  async loadSpriteAudio(sprite) {
    sprite.audioEntry = await this.audioCatalog.load(sprite.characterId);
    if (!sprite.audioEntry) {
      sprite.audioCategories = new Set();
    } else if (sprite.savedAudioCategories) {
      const valid = new Set(sprite.audioEntry.categories.keys());
      sprite.audioCategories = new Set(sprite.savedAudioCategories.filter((c) => valid.has(c)));
      sprite.savedAudioCategories = null;
    } else {
      // All categories selected by default.
      sprite.audioCategories = new Set(sprite.audioEntry.categories.keys());
    }
    this.emit("audioReady", sprite);
  }

  playSpriteAudio(sprite) {
    if (sprite.muted || this.audioVolume <= 0) return;
    if (!sprite.audioEntry) return;

    // Custom audio (files next to the asset / uploaded): play the sprite's
    // snippet segment when one is set, else a random one of the files.
    const custom = sprite.audioEntry.custom;
    if (custom && custom.length) {
      const snip = sprite.audioSnippet;
      if (snip) {
        const line =
          custom.find((l) => l.name === snip.name) ??
          (snip.file ? { name: snip.name, url: snip.file } : null);
        if (line) {
          this._playSnippet(sprite, line.url, snip.start, snip.end);
          return;
        }
        // The snippet's file no longer exists — fall through to random.
      }
      const line = custom[Math.floor(Math.random() * custom.length)];
      this._playAudioUrl(sprite, line.url);
      return;
    }

    // Back-compat: the voice-line catalogue, one random line from the
    // selected categories.
    const cats = [...sprite.audioCategories].filter((c) => sprite.audioEntry.categories.has(c));
    if (!cats.length) return;
    const category = cats[Math.floor(Math.random() * cats.length)];
    const lines = sprite.audioEntry.categories.get(category);
    const line = lines[Math.floor(Math.random() * lines.length)];
    this._playAudioUrl(sprite, line.url);
  }

  /** Set (or clear with null) the audio snippet for a sprite and persist. */
  setAudioSnippet(spriteId, snippet) {
    const sprite = this.sprites.get(spriteId);
    if (!sprite) return null;
    if (!snippet) {
      sprite.audioSnippet = null;
    } else {
      sprite.audioSnippet = {
        file: snippet.file ?? null,
        name: snippet.name ?? null,
        start: Number(snippet.start) || 0,
        end: snippet.end != null ? Number(snippet.end) : null,
      };
    }
    this.persistStage();
    return sprite.audioSnippet;
  }

  /** Play a whole audio URL (respects global volume; ignores per-sprite mute
   *  so the editor can audition files on a muted element). */
  playAudioUrl(sprite, url) {
    if (this.audioVolume <= 0) return;
    this._playAudioUrl(sprite, url);
  }

  /** Stop whatever audio a sprite is playing (also used before a new play). */
  _stopSpriteAudio(sprite) {
    if (sprite.audio) {
      try {
        sprite.audio.pause();
      } catch {}
      sprite.audio = null;
    }
  }

  /** Play a single URL through a fresh Audio element (respects volume). */
  _playAudioUrl(sprite, url) {
    this._stopSpriteAudio(sprite);
    try {
      const audio = new Audio(url);
      audio.volume = this.audioVolume;
      audio.play().catch(() => {});
      sprite.audio = audio;
    } catch {
      // Audio blocked or unavailable — ignore.
    }
  }

  /**
   * Play the audio segment [start, end] (seconds) of an audio URL. Starts at
   * `start` once the element is ready and pauses when the playhead passes
   * `end` — the same snippet logic runs in the editor and in the exported
   * wallpaper (this class is shared by both entry points).
   */
  _playSnippet(sprite, url, start, end) {
    this._stopSpriteAudio(sprite);
    const s = Math.max(0, Number(start) || 0);
    let e = Number(end);
    try {
      const audio = new Audio(url);
      audio.volume = this.audioVolume;
      audio.preload = "auto";
      const begin = () => {
        const dur =
          typeof audio.duration === "number" && Number.isFinite(audio.duration)
            ? audio.duration
            : null;
        if (dur != null && e == null) e = dur;
        if (e != null && dur != null) e = Math.min(e, dur);
        const maxStart = dur != null ? Math.max(0, dur - 0.05) : s;
        try {
          audio.currentTime = Math.min(s, maxStart);
        } catch {}
        audio.play().catch(() => {});
      };
      audio.addEventListener("loadedmetadata", begin, { once: true });
      audio.addEventListener("canplay", begin, { once: true });
      audio.addEventListener("timeupdate", () => {
        if (e != null && audio.currentTime >= e) {
          try {
            audio.pause();
          } catch {}
        }
      });
      audio.play().catch(() => {});
      sprite.audio = audio;
    } catch {
      // Audio blocked or unavailable — ignore.
    }
  }

  /** Press a sprite: play its voice line and start the click (hold) animation. */
  pressSprite(sprite) {
    this.playSpriteAudio(sprite);
    const name = sprite.clickAnimation;
    if (name && name !== "none") {
      this.holdingSprite = sprite;
      sprite.model.startClickAnimation(name);
    }
  }

  /** Release the held sprite: finish the click animation gracefully. */
  releaseSprite() {
    if (!this.holdingSprite) return;
    const sprite = this.holdingSprite;
    this.holdingSprite = null;
    sprite.model.stopClickAnimation();
  }

  /** Reset tint, size, position, colour balance and opacity of all sprites. */
  resetEdits() {
    for (const sprite of this.sprites.values()) {
      sprite.model.layoutConfig = { x: null, y: null, scale: 1, fw: null, fh: null };
      sprite.model.setMirror(false);
      sprite.opacity = 1;
      sprite.tint = "#ffffff";
      sprite.brightness = 1;
      sprite.rgb = { r: 1, g: 1, b: 1 };
      this.applySpriteColor(sprite);
    }
    this.stageRenderer.resize();
    this.emit("editsReset");
    this.persistStage();
  }

  /** Re-apply a sprite's current colour (tint × brightness × RGB balance,
   *  plus opacity) to its model. Call after any colour/opacity change or
   *  after a model reload (a fresh skeleton resets its colour to white). */
  applySpriteColor(sprite) {
    const rgb = sprite.rgb || {};
    sprite.model.setColor(
      sprite.tint,
      sprite.opacity,
      sprite.brightness ?? 1,
      rgb.r ?? 1,
      rgb.g ?? 1,
      rgb.b ?? 1
    );
  }

  /* ------------------------------------------------------------------ *
   * Layers (bottom→top stack; within a layer, last-moved-on-top)
   * ------------------------------------------------------------------ */

  /** Add a new layer on top of the stack; returns its id. */
  addLayer(name) {
    name = String(name || "").trim() || `Layer ${this.layers.length + 1}`;
    let n = 1;
    while (this.layers.some((l) => l.id === `layer-${n}`)) n++;
    const id = `layer-${n}`;
    this.layers.push({ id, name });
    this._syncLayers();
    return id;
  }

  renameLayer(id, name) {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    name = String(name || "").trim();
    if (!name) return;
    layer.name = name;
    this.emit("layersChanged");
    this.persistStage();
  }

  /** Remove a layer; its sprites move to the bottom (first) layer. */
  removeLayer(id) {
    if (this.layers.length <= 1) return; // keep at least one layer
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    this.layers.splice(idx, 1);
    const fallback = this.layers[0].id;
    for (const s of this.sprites.values()) {
      if (s.layer === id) {
        s.layer = fallback;
        s.model.layer = fallback;
      }
    }
    this._syncLayers();
  }

  /** Move a layer to a new position in the bottom→top stack. */
  reorderLayer(id, targetIndex) {
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    targetIndex = Math.max(0, Math.min(this.layers.length - 1, targetIndex));
    if (idx === targetIndex) return;
    const [layer] = this.layers.splice(idx, 1);
    this.layers.splice(targetIndex, 0, layer);
    this._syncLayers();
  }

  /** Assign a sprite to a layer. */
  setSpriteLayer(spriteId, layerId) {
    const sprite = this.sprites.get(spriteId);
    if (!sprite || !this.layers.some((l) => l.id === layerId)) return;
    sprite.layer = layerId;
    sprite.model.layer = layerId;
    this._syncLayers();
  }

  /** Rebuild the draw order + UI after any layer change. */
  _syncLayers() {
    this.stageRenderer.applyLayerOrder(this.layers.map((l) => l.id));
    this.stageRenderer.resize();
    this.emit("layersChanged");
    this.persistStage();
  }

  /* ------------------------------------------------------------------ *
   * Stage persistence (saved across reloads)
   * ------------------------------------------------------------------ */

  serializeSprite(s) {
    return {
      characterId: s.characterId,
      kind: s.kind,
      variant: s.variant,
      animation: s.model.currentAnimation,
      clickAnimation: s.clickAnimation,
      speed: s.model.speed,
      loop: s.model.loop,
      paused: s.model.paused,
      x: s.model.layoutConfig ? s.model.layoutConfig.x ?? null : null,
      y: s.model.layoutConfig ? s.model.layoutConfig.y ?? null : null,
      scale: s.model.layoutConfig ? s.model.layoutConfig.scale ?? 1 : 1,
      fw: s.model.layoutConfig ? s.model.layoutConfig.fw ?? null : null,
      fh: s.model.layoutConfig ? s.model.layoutConfig.fh ?? null : null,
      opacity: s.opacity,
      tint: s.tint,
      brightness: s.brightness ?? 1,
      rgb: { r: s.rgb?.r ?? 1, g: s.rgb?.g ?? 1, b: s.rgb?.b ?? 1 },
      mirror: s.model.mirror ?? false,
      layer: s.layer,
      audioCategories: [...s.audioCategories],
      audioSnippet: s.audioSnippet ? { ...s.audioSnippet } : undefined,
      muted: s.muted,
    };
  }

  /** Snapshot the whole stage setup (characters, variants, animations, ...). */
  captureStage() {
    const active = this.getActiveSprite();
    return {
      active: active ? active.characterId : null,
      layers: this.layers.map((l) => ({ id: l.id, name: l.name })),
      sprites: [...this.sprites.values()].map((s) => this.serializeSprite(s)),
      // Z-order as character ids, bottom to top (topmost last).
      zOrder: this.stageRenderer
        .drawOrder()
        .map((model) => this.findSpriteByModel(model)?.characterId ?? null)
        .filter(Boolean),
      audioVolume: this.audioVolume,
    };
  }

  /** Re-apply a saved z-order (array of character ids) to the current stage. */
  applyZOrder(savedOrder) {
    if (!Array.isArray(savedOrder)) return;
    const byCharacter = new Map([...this.sprites.values()].map((s) => [s.characterId, s.model]));
    const ordered = [];
    const seen = new Set();
    for (const characterId of savedOrder) {
      const model = byCharacter.get(characterId);
      if (model && !seen.has(characterId)) {
        seen.add(characterId);
        ordered.push(model);
      }
    }
    // Append any sprites not mentioned (e.g. older saves without a z-order).
    for (const s of this.sprites.values()) {
      if (!seen.has(s.characterId)) ordered.push(s.model);
    }
    this.stageRenderer.setDrawOrder(ordered);
  }

  persistStage() {
    if (!this.persist) return;
    const state = this.captureStage();
    try {
      localStorage.setItem(STAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn("cannot persist stage:", err);
    }
    // Let the owner (the editor's scene manager) keep its record in sync.
    if (this.onPersist) {
      try {
        this.onPersist(state);
      } catch (err) {
        console.warn("onPersist failed:", err);
      }
    }
  }

  /** Recreate the saved stage on boot. Returns true if anything was restored. */
  restoreStage() {
    let saved = null;
    try {
      const raw = localStorage.getItem(STAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (err) {
      console.warn("cannot restore stage:", err);
    }
    if (!saved || !Array.isArray(saved.sprites) || !saved.sprites.length) return false;

    if (typeof saved.audioVolume === "number") this.audioVolume = saved.audioVolume;

    // Layers: saved list, else a single default layer (migration of old saves
    // that only had a global z-order).
    if (Array.isArray(saved.layers) && saved.layers.length) {
      this.layers = saved.layers
        .filter((l) => l && l.id)
        .map((l) => ({ id: l.id, name: l.name || l.id }));
    } else {
      this.layers = [{ id: "layer-1", name: "Layer 1" }];
    }

    let added = false;
    for (const entry of saved.sprites) {
      if (this.sprites.size >= MAX_SPRITES) break;
      if (!entry || !entry.characterId) continue;
      const sprite = this.addSprite(entry.characterId, { activate: false, settings: entry });
      if (sprite) added = true;
    }
    if (added) {
      const wanted = saved.active
        ? [...this.sprites.values()].find((s) => s.characterId === saved.active)
        : null;
      const target = wanted ?? this.sprites.values().next().value;
      if (target) this.activateSprite(target.id);
      // Restore the within-layer (last-moved) order, then group by layer.
      this.applyZOrder(saved.zOrder);
      this.stageRenderer.applyLayerOrder(this.layers.map((l) => l.id));
      this.persistStage();
    }
    return added;
  }

  /** Reset the stage to the default single sprite (background stays as-is). */
  resetStage() {
    for (const s of [...this.sprites.values()]) this.removeSprite(s.id);
    try {
      localStorage.removeItem(STAGE_KEY);
    } catch (err) {
      console.warn("cannot clear saved stage:", err);
    }
    if (this.characters.length) this.addSprite(this.characters[0].id);
  }

  /* ------------------------------------------------------------------ *
   * Background (colour / device image, persisted across reloads)
   * ------------------------------------------------------------------ */

  applyBackground() {
    if (this.bgMode === "image" && this.bgImageUrl) {
      if (this.bgIsVideo) {
        // Video background: a muted looping <video> behind the canvas.
        this.stage.style.backgroundColor = "transparent";
        this.stage.style.backgroundImage = "none";
        this._ensureBgVideo(this.bgImageUrl);
      } else {
        this._clearBgVideo();
        // Use longhand properties only — the background shorthand resets siblings.
        this.stage.style.backgroundColor = "transparent";
        this.stage.style.backgroundImage = `url("${this.bgImageUrl}")`;
        this.stage.style.backgroundSize = "cover"; // fill, crop overflow
        this.stage.style.backgroundPosition = "center";
        this.stage.style.backgroundRepeat = "no-repeat";
      }
    } else {
      this._clearBgVideo();
      this.stage.style.backgroundColor = this.bgMode === "transparent" ? "transparent" : this.bgColor;
      this.stage.style.backgroundImage = "none";
    }
    this.emit("bgChanged");
    this.persistBg();
  }

  /** Create (or update) the muted looping <video> behind the canvas. */
  _ensureBgVideo(url) {
    let video = this.stage.querySelector("video.bg-video");
    if (!video) {
      video = document.createElement("video");
      video.className = "bg-video";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      this.stage.prepend(video); // before the canvas => painted underneath
    }
    if (video.getAttribute("src") !== url) {
      video.src = url;
      video.load();
      video.play().catch(() => {});
    }
    this.bgVideoEl = video;
  }

  /** Remove the background video element, if any. */
  _clearBgVideo() {
    const video = this.stage.querySelector("video.bg-video");
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (err) {
        console.warn("bg video teardown failed:", err);
      }
      video.remove();
    }
    this.bgVideoEl = null;
  }

  persistBg() {
    if (!this.persist) return;
    try {
      localStorage.setItem(BG_KEY, JSON.stringify({ mode: this.bgMode, color: this.bgColor }));
    } catch (err) {
      console.warn("cannot persist background:", err);
    }
  }

  restoreBg() {
    try {
      const raw = localStorage.getItem(BG_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        this.bgMode = saved.mode || "transparent";
        this.bgColor = saved.color || "#000000";
      }
    } catch (err) {
      console.warn("cannot restore background:", err);
    }
    this.applyBackground();
    // Image/video blobs live in IndexedDB (localStorage is too small) — restore async.
    this.loadBgImageBlob(this.bgDbKey)
      .then((blob) => {
        if (!blob) {
          if (this.bgMode === "image") {
            this.bgMode = "transparent";
            this.applyBackground();
          }
          return;
        }
        if (this.bgImageUrl) URL.revokeObjectURL(this.bgImageUrl);
        this.bgImageBlob = blob;
        this.bgImageUrl = URL.createObjectURL(blob);
        this.bgIsVideo = blob.type.startsWith("video/");
        if (this.bgMode === "image") this.applyBackground();
      })
      .catch((err) => console.warn("cannot restore background image:", err));
  }

  openBgDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BG_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(BG_DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async saveBgImage(blob, key = this.bgDbKey) {
    const db = await this.openBgDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BG_DB_STORE, "readwrite");
      tx.objectStore(BG_DB_STORE).put(blob, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadBgImageBlob(key = this.bgDbKey) {
    const db = await this.openBgDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BG_DB_STORE, "readonly");
      const req = tx.objectStore(BG_DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBgImage(key = this.bgDbKey) {
    const db = await this.openBgDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BG_DB_STORE, "readwrite");
      tx.objectStore(BG_DB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  applyBgImage(file) {
    if (this.bgImageUrl) URL.revokeObjectURL(this.bgImageUrl);
    this.bgImageBlob = file;
    this.bgImageUrl = URL.createObjectURL(file);
    this.bgIsVideo = !!(file && file.type && file.type.startsWith("video/"));
    this.bgMode = "image";
    this.applyBackground();
    this.saveBgImage(file, this.bgDbKey).catch((err) => console.warn("cannot save background image:", err));
    // Keep the legacy "current" key in sync so first-run migration (and the
    // wallpaper fallback) can always recover the last applied background.
    if (this.persist && this.bgDbKey !== BG_DB_KEY) {
      this.saveBgImage(file, BG_DB_KEY).catch((err) => console.warn("cannot save background image:", err));
    }
  }

  /**
   * Replace the whole controller state from a saved scene snapshot: sprites,
   * layers, audio volume and background. Used by the editor when switching
   * scenes and by the wallpaper entry point. The background image/video blob
   * is loaded from IndexedDB under `bgBlobKey` (defaults to this.bgDbKey).
   * @returns {Promise<number>} number of sprites restored
   */
  async applyState(state, opts = {}) {
    state = state || {};
    for (const s of [...this.sprites.values()]) this.removeSprite(s.id);

    // Background mode/colour first; the blob is applied async below.
    this.bgMode = state.bg?.mode || "transparent";
    this.bgColor = state.bg?.color || "#000000";
    if (this.bgImageUrl) {
      URL.revokeObjectURL(this.bgImageUrl);
      this.bgImageUrl = null;
    }
    this.bgImageBlob = null;
    this.bgIsVideo = false;
    if (state.bg?.file) {
      // Baked/static export: the background is a packaged file referenced by
      // URL (no IndexedDB, no blob) — used by exported wallpapers.
      this.bgImageUrl = state.bg.file;
      this.bgIsVideo = !!state.bg.video;
    } else if (opts.loadBgBlob !== false) {
      try {
        const blob = await this.loadBgImageBlob(opts.bgBlobKey || this.bgDbKey);
        if (blob) {
          this.bgImageBlob = blob;
          this.bgImageUrl = URL.createObjectURL(blob);
          this.bgIsVideo = blob.type.startsWith("video/");
          // Mirror into the legacy "current" key for first-run migration.
          if (this.persist && (opts.bgBlobKey || this.bgDbKey) !== BG_DB_KEY) {
            this.saveBgImage(blob, BG_DB_KEY).catch((err) => console.warn("cannot save background image:", err));
          }
        }
      } catch (err) {
        console.warn("cannot load scene background:", err);
      }
    }
    if (this.bgMode === "image" && !this.bgImageUrl) this.bgMode = "transparent";
    this.applyBackground();

    // Global audio volume.
    this.audioVolume = typeof state.audioVolume === "number" ? state.audioVolume : 1;

    // Layers (default to a single layer for states saved without layers).
    if (Array.isArray(state.layers) && state.layers.length) {
      this.layers = state.layers
        .filter((l) => l && l.id)
        .map((l) => ({ id: l.id, name: l.name || l.id }));
    } else {
      this.layers = [{ id: "layer-1", name: "Layer 1" }];
    }

    // Recreate the saved sprites.
    let added = 0;
    for (const entry of state.sprites || []) {
      if (this.sprites.size >= MAX_SPRITES) break;
      if (!entry || !entry.characterId) continue;
      const sprite = this.addSprite(entry.characterId, { activate: false, settings: entry });
      if (sprite) added++;
    }
    if (added) {
      const wanted = state.active
        ? [...this.sprites.values()].find((s) => s.characterId === state.active)
        : null;
      const target = wanted ?? this.sprites.values().next().value;
      if (target) this.activateSprite(target.id);
      this.applyZOrder(state.zOrder);
      this.stageRenderer.applyLayerOrder(this.layers.map((l) => l.id));
    }
    this.persistStage();
    return added;
  }

  resize() {
    this.stageRenderer.resize();
  }
}
