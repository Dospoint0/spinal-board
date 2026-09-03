/**
 * Spine rendering for the viewer.
 *
 *  - SpineModel    — one loaded skeleton with playback state. No canvas, no
 *                    GL, no render loop: it renders into a SceneRenderer
 *                    (shared by the stage) using its own camera, and can be
 *                    fitted/scaled on the shared canvas. Content may extend
 *                    beyond a sprite's fitted frame and overlap neighbours
 *                    (only the canvas edge clips).
 *  - SpinePlayer   — self-contained player (own canvas/renderer/loop) around a
 *                    SpineModel, used for offscreen preview thumbnails.
 *  - StageRenderer — renders many SpineModels on ONE shared canvas: one frame
 *                    loop, one clear, one draw per model with a per-model
 *                    camera. Every sprite keeps its own explicit layout —
 *                    there is no automatic equal-width arrangement and no
 *                    auto re-fit when sprites are added or removed.
 *
 * Runtime selection: the bundled runtimes are spine-webgl 4.0.31
 * (window.spine40) and 4.1.56 (window.spine41); each skeleton is decoded by
 * the runtime matching its version header, and each runtime gets its own
 * SceneRenderer on the shared WebGL context.
 */
import { detectSkeletonVersion, pickRuntime } from "./runtime-loader.js";
import { parseGIF, decompressFrames } from "gifuct-js";
import { Live2DModel } from "./live2d.js";

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** How much of its fitted frame the model's body should fill when fitted. */
export const FIT_MARGIN = 0.9;

const WEBGL_OPTS = { alpha: true, antialias: true, premultipliedAlpha: true };

/** Ray-casting point-in-polygon test over a flat [x, y, ...] vertex array. */
function pointInPolygon(x, y, vertices, vertexCount) {
  let inside = false;
  let j = vertexCount - 1;
  for (let i = 0; i < vertexCount; i++) {
    const xi = vertices[i * 2];
    const yi = vertices[i * 2 + 1];
    const xj = vertices[j * 2];
    const yj = vertices[j * 2 + 1];
    if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
      if (xi + ((y - yi) / (yj - yi)) * (xj - xi) < x) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/** Load an <img> element (resolves with the element once decoded). */
function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Cannot load image: ${url}`));
    img.src = url;
  });
}

/** Create a muted looping <video> element; resolves once its dimensions are
 *  known (metadata loaded). The element is kept in the DOM (fixed, off-screen)
 *  because some browsers only deliver frames to a playing, laid-out element. */
function loadVideoElement(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.style.position = "fixed";
    video.style.left = "-9999px";
    video.style.width = "2px";
    video.style.height = "2px";
    const fail = () => reject(new Error(`Cannot load video: ${url}`));
    video.addEventListener("error", fail);
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (!video.videoWidth || !video.videoHeight) return fail();
        resolve(video);
      },
      { once: true }
    );
    document.body.appendChild(video);
    video.src = url;
    video.load();
    video.play().catch(() => {});
  });
}

/* ------------------------------------------------------------------ *
 * SpineModel
 * ------------------------------------------------------------------ */

export class SpineModel {
  constructor() {
    /** Raw WebGL context (set by the owner before load()). */
    this.gl = null;
    this.runtime = null;
    this.runtimeName = null;
    this.atlas = null;
    this.skeleton = null;
    this.state = null;
    this.stateData = null;
    /** OrthoCamera from this.runtime, created on load. */
    this.camera = null;
    /** World-space bounds of the model (setup pose). */
    this.bounds = { x: 0, y: 0, w: 0, h: 0 };

    this.animationNames = [];
    this.currentAnimation = null;
    this.playing = false;
    this.paused = false;
    this.loop = true;
    this.speed = 1;
    this.mirror = false; // horizontally mirrored (flips the rendered image)
    /** "spine" (skeleton) | "image" (single image) | "video" (webm texture)
     *  | "gif" (gifuct-decoded animated canvas). */
    this.kind = "spine";
    /** <video> element for kind "video" (re-uploaded as a texture per frame). */
    this.videoEl = null;
    /** Offscreen canvas for kind "gif" (decoded frames painted per tick). */
    this.gifCanvas = null;
    this.gifFrames = null; // decoded patches (gifuct)
    this.gifTime = 0; // elapsed play time in seconds
    this.gifIndex = 0; // current frame index
    this.gifTotal = 0; // total duration in seconds
    this.gifLastTick = 0; // last rAF timestamp for wall-clock advancement
    /** Live2D/Cubism model for kind "live2d" (null otherwise). */
    this.live2d = null;
    /** GLTexture for kind "image"/"video" (video frames refreshed every frame). */
    this.texture = null;
    this._clickActive = false;

    this._loadToken = 0;
    this.loadId = 0;
    this.onAnimationsChanged = null;
    this.onStatus = null;
  }

  get premultipliedAlpha() {
    return this.atlas && this.atlas.pages.length ? !!this.atlas.pages[0].pma : false;
  }

  /** Load a skeleton + atlas (+ referenced textures). Requires this.gl. */
  async load(entry) {
    const token = ++this._loadToken;
    this._setStatus("Loading…");
    try {
      const [skelRes, atlasRes] = await Promise.all([fetch(entry.skel), fetch(entry.atlas)]);
      if (!skelRes.ok) throw new Error(`Cannot fetch ${entry.skel} (HTTP ${skelRes.status})`);
      if (!atlasRes.ok) throw new Error(`Cannot fetch ${entry.atlas} (HTTP ${atlasRes.status})`);
      if (token !== this._loadToken) return;

      const skeletonBytes = new Uint8Array(await skelRes.arrayBuffer());
      const atlasText = await atlasRes.text();

      const version = detectSkeletonVersion(skeletonBytes);
      const runtime = pickRuntime(version);
      if (token !== this._loadToken) return;
      if (!this.gl) throw new Error("SpineModel.gl must be set before load()");

      this._disposeModel();
      this.runtime = runtime;
      this.runtimeName = version.startsWith("4.0") ? "4.0.31" : "4.1.56";
      this._setStatus(`Parsing skeleton (Spine ${version}, runtime ${this.runtimeName})…`);

      const atlas = new runtime.TextureAtlas(atlasText);
      await this._loadTextures(atlas, entry.atlas);
      if (token !== this._loadToken) return;

      const loader = new runtime.AtlasAttachmentLoader(atlas);
      const data = new runtime.SkeletonBinary(loader).readSkeletonData(skeletonBytes);
      if (token !== this._loadToken) return;

      this.atlas = atlas;
      this.skeleton = new runtime.Skeleton(data);
      this.stateData = new runtime.AnimationStateData(data);
      this.state = new runtime.AnimationState(this.stateData);
      this.state.timeScale = this.speed;
      this.animationNames = data.animations.map((a) => a.name);
      this.camera = new runtime.OrthoCamera(1, 1);

      this._computeBounds();

      // Default animation: exact "idle", else any name containing "idle",
      // else the first animation.
      const wanted =
        this.animationNames.find((n) => n === "idle") ??
        this.animationNames.find((n) => n.includes("idle")) ??
        this.animationNames[0] ??
        null;
      this.currentAnimation = wanted;
      if (wanted) this.state.setAnimation(0, wanted, this.loop);
      this.playing = !!wanted;
      this.paused = false;

      this.onAnimationsChanged?.(this.animationNames, wanted);
      this._setStatus(
        `Loaded ${this.skeleton.data.name || "character"} — ${this.animationNames.length} animation(s)`
      );
      this.loadId++;
    } catch (err) {
      if (token === this._loadToken) {
        console.error("[SpineModel] load failed:", err);
        this._setStatus(`Error: ${err.message}`);
        this.animationNames = [];
        this.currentAnimation = null;
        this.playing = false;
        this.onAnimationsChanged?.(this.animationNames, null);
        this.loadId++;
        throw err;
      }
      // A newer load superseded this one; silently ignore.
    }
  }

  /**
   * Load a plain image (png/jpg/webp/gif) as a single-region skeleton
   * (kind "image"). The whole SpineModel pipeline — camera fit, hit-testing,
   * mirror, tint, opacity, layers — then works unchanged.
   * @param {string} url image URL
   */
  async loadImageAsset(url) {
    const token = ++this._loadToken;
    this._setStatus("Loading image…");
    try {
      const img = await loadImageElement(url);
      if (token !== this._loadToken) return;
      if (!this.gl) throw new Error("SpineModel.gl must be set before load()");
      this._disposeModel();
      this.runtime = pickRuntime("4.1");
      this.runtimeName = "4.1.56";
      this.kind = "image";
      this._setStatus("Preparing image…");
      this._initFromImageLike(img, img.naturalWidth, img.naturalHeight);
      this._uploadTexturePremultiplied(this.texture, img);
      this._setStatus(`Loaded image ${url}`);
      this.onAnimationsChanged?.(this.animationNames, null);
      this.loadId++;
    } catch (err) {
      if (token === this._loadToken) {
        console.error("[SpineModel] image load failed:", err);
        this._setStatus(`Error: ${err.message}`);
        this.animationNames = [];
        this.currentAnimation = null;
        this.playing = false;
        this.onAnimationsChanged?.(this.animationNames, null);
        this.loadId++;
        throw err;
      }
    }
  }

  /**
   * Load a webm video as a looping animated sprite (kind "video"). The video
   * element plays muted in the background; every frame the StageRenderer
   * re-uploads its current frame as the texture.
   * @param {string} url video URL
   */
  async loadVideoAsset(url) {
    const token = ++this._loadToken;
    this._setStatus("Loading video…");
    try {
      const video = await loadVideoElement(url);
      if (token !== this._loadToken) return;
      if (!this.gl) throw new Error("SpineModel.gl must be set before load()");
      this._disposeModel();
      this.runtime = pickRuntime("4.1");
      this.runtimeName = "4.1.56";
      this.kind = "video";
      this.videoEl = video;
      this._setStatus("Preparing video…");
      this._initFromImageLike(video, video.videoWidth, video.videoHeight);
      video.play().catch(() => {});
      this._setStatus(`Loaded video ${url}`);
      this.onAnimationsChanged?.(this.animationNames, null);
      this.loadId++;
    } catch (err) {
      if (token === this._loadToken) {
        console.error("[SpineModel] video load failed:", err);
        this._setStatus(`Error: ${err.message}`);
        this.animationNames = [];
        this.currentAnimation = null;
        this.playing = false;
        this.onAnimationsChanged?.(this.animationNames, null);
        this.loadId++;
        throw err;
      }
    }
  }

  /**
   * Load an animated GIF as a looping animated sprite (kind "gif"). The GIF
   * is decoded with gifuct-js into per-frame patches that are painted onto an
   * offscreen canvas; every frame the StageRenderer re-uploads that canvas as
   * the texture (the same mechanism as video). Frame patches are composited by
   * overlay — full-frame GIFs reproduce exactly; exotic GIFs that rely on
   * partial-frame disposal may keep stale pixels until the loop wraps (the
   * canvas is cleared on wrap). @param {string} url GIF URL
   */
  async loadGifAsset(url) {
    const token = ++this._loadToken;
    this._setStatus("Loading GIF…");
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Cannot fetch ${url} (HTTP ${res.status})`);
      const buffer = await res.arrayBuffer();
      if (token !== this._loadToken) return;

      const gif = parseGIF(buffer);
      const frames = decompressFrames(gif, true);
      if (!frames || !frames.length) throw new Error(`No frames found in ${url}`);
      if (!this.gl) throw new Error("SpineModel.gl must be set before load()");

      this._disposeModel();
      this.runtime = pickRuntime("4.1");
      this.runtimeName = "4.1.56";
      this.kind = "gif";

      const w = gif.lsd?.width ?? frames[0].dims?.width ?? 1;
      const h = gif.lsd?.height ?? frames[0].dims?.height ?? 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));

      this.gifCanvas = canvas;
      this.gifFrames = frames;
      this.gifTime = 0;
      this.gifIndex = 0;
      this.gifTotal = frames.reduce((sum, f) => sum + ((f.delay || 100) / 1000), 0);

      this._setStatus("Preparing GIF…");
      // Frame 0 must be on the canvas before the texture is created/uploaded.
      this._paintGifFrame(frames[0], true);
      this._initFromImageLike(canvas, canvas.width, canvas.height);
      this._uploadTexturePremultiplied(this.texture, canvas);

      // The GIF advances on wall clock via gifTick() (see StageRenderer); the
      // single-region skeleton has no animations, so mark it playing.
      this.playing = true;
      this.paused = false;
      this.gifLastTick = 0;

      this._setStatus(`Loaded GIF ${url} — ${frames.length} frame(s)`);
      this.onAnimationsChanged?.(this.animationNames, null);
      this.loadId++;
    } catch (err) {
      if (token === this._loadToken) {
        console.error("[SpineModel] GIF load failed:", err);
        this._setStatus(`Error: ${err.message}`);
        this.animationNames = [];
        this.currentAnimation = null;
        this.playing = false;
        this.onAnimationsChanged?.(this.animationNames, null);
        this.loadId++;
        throw err;
      }
    }
  }

  /**
   * Load a Live2D/Cubism (.model3.json) model as kind "live2d". The model
   * renders into its own offscreen Cubism canvas; that canvas is composited
   * through the single-region-skeleton texture path (like video/GIF), so
   * layout / drag / resize / mirror / tint / hit-testing all reuse the proven
   * spine pipeline. Without the runtime it fails and degrades to a placeholder.
   * @param {string} url model3.json URL
   */
  async loadLive2DAsset(url) {
    const token = ++this._loadToken;
    this._setStatus("Loading Live2D…");
    try {
      this._disposeModel();
      this.runtime = pickRuntime("4.1");
      this.runtimeName = "4.1.56";
      this.kind = "live2d";
      const lm = new Live2DModel();
      lm.onStatus = (msg) => this._setStatus(msg);
      this.live2d = lm;
      await lm.load(url);
      if (token !== this._loadToken) return;
      if (!lm.canvas) throw new Error("Live2D offscreen canvas unavailable");
      // Build the single-region skeleton around the offscreen canvas: bounds,
      // layout, mirror, tint/opacity and hit-testing then come from the normal
      // image/video pipeline.
      this._initFromImageLike(lm.canvas, lm.canvas.width, lm.canvas.height);
      this.kind = "live2d";
      this.playing = true;
      this.paused = !!lm.paused;
      // The model's motion files become the sprite's animations (like Spine
      // skeleton animations), so the editor's Animation/Click selects and the
      // click/hold behaviour work identically for Live2D sprites.
      this.animationNames = lm.animNames.slice();
      this.currentAnimation = lm.currentAnimation;
      this._setStatus(`Loaded Live2D ${url}`);
      this.onAnimationsChanged?.(this.animationNames, this.currentAnimation);
      this.loadId++;
    } catch (err) {
      if (token === this._loadToken) {
        console.error("[SpineModel] Live2D load failed:", err);
        this._setStatus(`Error: ${err.message}`);
        this.animationNames = [];
        this.currentAnimation = null;
        this.playing = false;
        this.onAnimationsChanged?.(this.animationNames, null);
        this.loadId++;
        throw err;
      }
    }
  }

  /** Paint one decoded GIF frame (patch) onto the sprite canvas. gifuct-js
   *  2.x exposes each patch as a raw RGBA Uint8ClampedArray covering the
   *  frame's dims area — wrap it in an ImageData before putImageData. */
  _paintGifFrame(frame, clear) {
    if (!this.gifCanvas || !frame) return;
    const ctx = this.gifCanvas.getContext("2d");
    if (clear) ctx.clearRect(0, 0, this.gifCanvas.width, this.gifCanvas.height);
    const patch = frame.patch;
    if (!patch) return;
    const d = frame.dims || {};
    const w = d.width || this.gifCanvas.width;
    const h = d.height || this.gifCanvas.height;
    if (patch.length !== w * h * 4) return; // defensive: skip malformed frames
    const img = ctx.createImageData(w, h);
    img.data.set(patch);
    ctx.putImageData(img, d.left || 0, d.top || 0);
  }

  /**
   * Build a minimal single-region skeleton around an image-like source
   * (<img> or <video>): one root bone, one slot, one region attachment.
   * The atlas/skin JSON is generated from the source's dimensions.
   */
  _initFromImageLike(source, w, h) {
    const runtime = this.runtime;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const atlasText = [
      "img.png",
      `size: ${w}, ${h}`,
      "format: RGBA8888",
      "filter: Linear, Linear",
      "repeat: none",
      "pma: true",
      // NOTE: no blank line here — the atlas parser treats a blank line as a
      // page separator, so the first region must follow the page header
      // directly (like a real Spine .atlas file).
      "img",
      "  rotate: false",
      "  xy: 0, 0",
      `  size: ${w}, ${h}`,
      `  orig: ${w}, ${h}`,
      "  offset: 0, 0",
      "  index: -1",
      "",
    ].join("\n");
    const atlas = new runtime.TextureAtlas(atlasText);
    const texture = new runtime.GLTexture(this.gl, source);
    atlas.pages[0].setTexture(texture);
    const loader = new runtime.AtlasAttachmentLoader(atlas);
    const data = new runtime.SkeletonJson(loader).readSkeletonData(
      JSON.stringify({
        skeleton: { hash: "", spine: "4.1.0", width: w, height: h },
        bones: [{ name: "root" }],
        slots: [{ name: "img", bone: "root", attachment: "img" }],
        // 4.1's SkeletonJson expects skins as an ARRAY of skin objects.
        skins: [
          { name: "default", attachments: { img: { img: { width: w, height: h, type: "region" } } } },
        ],
      })
    );
    this.atlas = atlas;
    this.texture = texture;
    this.skeleton = new runtime.Skeleton(data);
    this.stateData = new runtime.AnimationStateData(data);
    this.state = new runtime.AnimationState(this.stateData);
    this.state.timeScale = this.speed;
    this.animationNames = [];
    this.currentAnimation = null;
    this.playing = false;
    this.paused = false;
    this.camera = new runtime.OrthoCamera(1, 1);
    this._computeBounds();
  }

  /**
   * Re-upload an image/video texture with premultiplied alpha. The shared
   * canvas and the spine characters use a premultiplied-alpha pipeline, so
   * straight-alpha images/videos must be premultiplied at upload or their
   * translucent edges would composite incorrectly.
   */
  _uploadTexturePremultiplied(texture, source) {
    if (!texture || !this.gl) return;
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      texture.update(false);
    } finally {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
  }

  async _loadTextures(atlas, atlasUrl) {
    const baseDir = atlasUrl.slice(0, atlasUrl.lastIndexOf("/") + 1);
    await Promise.all(
      atlas.pages.map(
        (page) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
              try {
                const texture = new this.runtime.GLTexture(this.gl, image);
                // setTexture wires the texture onto the page AND every region
                // (the 4.1 renderer reads region.texture, not page.texture).
                page.setTexture(texture);
                resolve();
              } catch (err) {
                reject(err);
              }
            };
            image.onerror = () =>
              reject(new Error(`Failed to load texture image: ${baseDir}${page.name}`));
            image.src = baseDir + page.name;
          })
      )
    );
  }

  _computeBounds() {
    const s = this.skeleton;
    s.setToSetupPose();
    s.updateWorldTransform();
    const offset = new this.runtime.Vector2();
    const size = new this.runtime.Vector2();
    s.getBounds(offset, size);
    this.bounds = { x: offset.x, y: offset.y, w: size.x, h: size.y };
  }

  /** Advance the animation state (spine only — GIFs advance on wall clock,
   *  Live2D advances its own motion manager). */
  update(delta) {
    if (this.kind === "live2d") {
      this.live2d?.update(delta);
      return;
    }
    if (!this.state || !this.skeleton || this.paused || !this.playing) return;
    this.state.update(delta);
    this.state.apply(this.skeleton);
    this.skeleton.updateWorldTransform();
  }

  /**
   * Advance the GIF clock using the real elapsed wall time between render
   * frames (the caller passes the rAF timestamp). GIF playback therefore
   * tracks real time even when the render loop is throttled (e.g. headless
   * Firefox), matching how video sprites behave.
   */
  gifTick(nowMs) {
    if (this.kind !== "gif" || !this.gifFrames || !this.gifCanvas) return;
    if (!this.gifLastTick) this.gifLastTick = nowMs;
    const dt = Math.max(0, (nowMs - this.gifLastTick) / 1000);
    this.gifLastTick = nowMs;
    if (dt > 0 && this.playing && !this.paused) {
      this.gifTime += dt * (Number.isFinite(this.speed) ? this.speed : 1);
      if (this.gifTotal > 0 && this.gifTime >= this.gifTotal) {
        if (this.loop) {
          this.gifTime %= this.gifTotal;
        } else {
          this.gifTime = this.gifTotal - 0.001; // hold the last frame
        }
      }
    } else if (this.paused) {
      this.gifLastTick = nowMs; // no catch-up jump when resumed
    }

    const t = Math.max(0, this.gifTime);
    const frames = this.gifFrames;
    let acc = 0;
    let idx = frames.length - 1;
    for (let i = 0; i < frames.length; i++) {
      const d = (frames[i].delay || 100) / 1000;
      if (acc + d > t || (i === frames.length - 1 && acc <= t)) {
        idx = i;
        break;
      }
      acc += d;
    }
    if (idx !== this.gifIndex) {
      this.gifIndex = idx;
      this._paintGifFrame(frames[idx], idx === 0);
    }
  }

  /** Draw this model with a SceneRenderer from the same runtime. */
  draw(renderer) {
    if (!renderer || !this.skeleton || !this.camera) return;
    renderer.camera = this.camera;
    renderer.begin();
    renderer.drawSkeleton(this.skeleton, this.premultipliedAlpha);
    renderer.end();
  }

  /**
   * Fit the model body (~FIT_MARGIN of the fit frame) centred at
   * (portionCenterX, portionCenterY) in viewport CSS pixels. The camera
   * viewport is the full canvas, so content may extend beyond the fitted
   * frame and overlap neighbours (only the canvas edge clips).
   * @param {number} scale multiplier (>1 enlarges the sprite)
   */
  layout(viewportW, viewportH, portionW, portionH, portionCenterX, portionCenterY, scale = 1) {
    if (!this.camera || !this.skeleton) return;
    const { x, y, w, h } = this.bounds;
    if (w <= 0 || h <= 0 || viewportW <= 0 || viewportH <= 0) return;
    const cam = this.camera;
    const zoom =
      Math.max(w / (FIT_MARGIN * portionW), h / (FIT_MARGIN * portionH)) / scale;
    // A negative viewport width flips the projection (mirrored rendering);
    // the renderer recomputes the camera every frame so this stays applied.
    cam.viewportWidth = this.mirror ? -viewportW : viewportW;
    cam.viewportHeight = viewportH;
    cam.zoom = zoom;
    const cx = x + w / 2;
    const cy = y + h / 2;
    // Shift the camera so the body centre maps to the portion centre.
    const camX = cx - (portionCenterX / viewportW - 0.5) * (zoom * viewportW);
    const camY = cy - (0.5 - portionCenterY / viewportH) * (zoom * viewportH);
    cam.position.set(camX, camY, 0);
    cam.update();
  }

  /**
   * Position the camera so the model's body fits an exact on-screen size
   * (widthPx × heightPx, in CSS pixels) centred at (centerX, centerY), scaled
   * by `scale` (default 1). Every sprite uses this once it has an explicit
   * layout (user-moved/resized, or the frozen default fit) — it never
   * re-flows or re-fits automatically.
   */
  layoutPinned(viewportW, viewportH, centerX, centerY, widthPx, heightPx, scale = 1) {
    if (!this.camera || !this.skeleton) return;
    const { x, y, w, h } = this.bounds;
    if (w <= 0 || h <= 0 || viewportW <= 0 || viewportH <= 0) return;
    const cam = this.camera;
    const zoom = Math.max(w / Math.max(widthPx * scale, 1), h / Math.max(heightPx * scale, 1));
    cam.viewportWidth = this.mirror ? -viewportW : viewportW;
    cam.viewportHeight = viewportH;
    cam.zoom = zoom;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const camX = cx - (centerX / viewportW - 0.5) * (zoom * viewportW);
    const camY = cy - (0.5 - centerY / viewportH) * (zoom * viewportH);
    cam.position.set(camX, camY, 0);
    cam.update();
  }

  /** Mirror the sprite horizontally (flips the rendered image left-right). */
  setMirror(mirror) {
    mirror = !!mirror;
    if (this.mirror === mirror) return;
    this.mirror = mirror;
    if (this.camera) {
      // Toggle the sign of the viewport width — the projection is rebuilt by
      // camera.update() (called every frame by the renderer), so the flip
      // persists.
      this.camera.viewportWidth = -this.camera.viewportWidth;
      this.camera.update();
    }
  }

  /**
   * Apply a tint colour (hex), opacity (0..1), brightness (0..2) and
   * per-channel RGB multipliers (0..2) to the whole skeleton. The final
   * channel value is `tint channel × channel multiplier × brightness`,
   * clamped to 0..1 (matching the framebuffer clamp at draw time).
   */
  setColor(tintHex, opacity, brightness = 1, rMul = 1, gMul = 1, bMul = 1) {
    if (!this.skeleton) return;
    const c = this.skeleton.color;
    let r = 1;
    let g = 1;
    let b = 1;
    if (tintHex) {
      const n = parseInt(String(tintHex).slice(1), 16);
      if (!Number.isNaN(n)) {
        r = ((n >> 16) & 255) / 255;
        g = ((n >> 8) & 255) / 255;
        b = (n & 255) / 255;
      }
    }
    const bri = Number.isFinite(brightness) ? brightness : 1;
    const mul = (v) => (Number.isFinite(v) ? v : 1);
    const clamp = (v) => Math.min(1, Math.max(0, v));
    c.set(
      clamp(r * mul(rMul) * bri),
      clamp(g * mul(gMul) * bri),
      clamp(b * mul(bMul) * bri),
      opacity
    );
  }

  /* ------------------------------------------------------------------ *
   * Playback controls
   * ------------------------------------------------------------------ */

  setAnimation(name, loop = this.loop) {
    if (this.kind === "live2d") {
      if (!this.live2d || !this.live2d.animNames.includes(name)) return false;
      this.currentAnimation = name;
      this.live2d.setMainAnimation(name); // async; load failures warn and no-op
      this.playing = true;
      this.paused = false;
      return true;
    }
    if (!this.state || !this.animationNames.includes(name)) return false;
    this.currentAnimation = name;
    this.loop = loop;
    this._clickActive = false;
    this.state.setAnimation(0, name, loop);
    this.playing = true;
    this.paused = false;
    return true;
  }

  togglePause() {
    if (this.kind === "live2d") {
      if (!this.live2d) return false;
      this.paused = !this.paused;
      this.live2d.paused = this.paused;
      return this.paused;
    }
    if (!this.state) return false;
    this.paused = !this.paused;
    if (!this.paused && this.currentAnimation) this.playing = true;
    return this.paused;
  }

  restart() {
    if (this.kind === "live2d") {
      if (!this.live2d) return false;
      const ok = this.live2d.restartMain();
      if (ok) {
        this.playing = true;
        this.paused = false;
        this.live2d.paused = false;
      }
      return ok;
    }
    if (!this.state || !this.currentAnimation) return false;
    this._clickActive = false;
    this.state.setAnimation(0, this.currentAnimation, this.loop);
    this.playing = true;
    this.paused = false;
    return true;
  }

  setLoop(loop) {
    this.loop = !!loop;
    const track = this.state?.tracks[0];
    if (track) track.loop = this.loop;
  }

  setSpeed(speed) {
    this.speed = Number(speed);
    if (this.state) this.state.timeScale = this.speed;
  }

  /** Loop a "click" animation while held; main animation resumes on stop. */
  startClickAnimation(name) {
    if (this.kind === "live2d") {
      if (!this.live2d || !this.live2d.animNames.includes(name)) return false;
      this.live2d.startClickAnimation(name); // async; failures warn and no-op
      this.playing = true;
      this.paused = false;
      return true;
    }
    if (!this.state || !this.currentAnimation) return false;
    if (!this.animationNames.includes(name)) return false;
    if (name === this.currentAnimation) return true;
    this._clickActive = true;
    this.state.setAnimation(0, name, true);
    this.playing = true;
    this.paused = false;
    return true;
  }

  /** End the held click animation gracefully (finish the current instance). */
  stopClickAnimation() {
    if (this.kind === "live2d") {
      if (!this.live2d) return false;
      this.live2d.stopClickAnimation();
      return true;
    }
    if (!this.state || !this.currentAnimation) return false;
    if (!this._clickActive) return true;
    this._clickActive = false;
    const track = this.state.tracks[0];
    if (track) {
      track.loop = false;
      this.state.addAnimation(0, this.currentAnimation, this.loop, 0);
    }
    this.playing = true;
    this.paused = false;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Hit testing (screen coords in canvas CSS pixels)
   * ------------------------------------------------------------------ */

  /** Model's screen-space bounding rect for the given canvas size. */
  modelRect(canvasW, canvasH) {
    if (!this.skeleton || !this.camera) return null;
    const vw = Math.abs(this.camera.viewportWidth); // sign encodes mirroring
    const vh = this.camera.viewportHeight;
    const zoom = this.camera.zoom;
    if (!vw || !vh || !zoom) return null;
    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    const left = camX - (zoom * vw) / 2;
    const bottom = camY - (zoom * vh) / 2;
    const cw = canvasW || 1;
    const ch = canvasH || 1;
    const { x, y, w, h } = this.bounds;
    if (w <= 0 || h <= 0) return null;
    const toX = (wx) => ((wx - left) / (zoom * vw)) * cw;
    const toY = (wy) => ch - ((wy - bottom) / (zoom * vh)) * ch;
    if (this.mirror) {
      // Horizontally mirrored: the model's left edge appears on the right.
      return { left: cw - toX(x + w), right: cw - toX(x), top: toY(y + h), bottom: toY(y) };
    }
    return { left: toX(x), right: toX(x + w), top: toY(y + h), bottom: toY(y) };
  }

  /** Tight hit test against the visible attachment geometry (current pose). */
  hitTest(x, y, canvasW, canvasH) {
    const w = this.screenToWorld(x, y, canvasW, canvasH);
    if (!w) return false;
    return this._pointInSkeleton(w.x, w.y);
  }

  /** Convert canvas CSS-pixel coordinates to the model's world space. */
  screenToWorld(x, y, canvasW, canvasH) {
    if (!this.camera) return null;
    const cam = this.camera;
    const vw = Math.abs(cam.viewportWidth); // sign encodes mirroring
    const vh = cam.viewportHeight;
    const zoom = cam.zoom;
    if (!vw || !vh || !zoom) return null;
    const left = cam.position.x - (zoom * vw) / 2;
    const bottom = cam.position.y - (zoom * vh) / 2;
    const cw = canvasW || 1;
    // Mirroring reflects the screen X axis around the canvas centre.
    const sx = this.mirror ? cw - x : x;
    return {
      x: left + (sx / cw) * (zoom * vw),
      y: bottom + (1 - y / (canvasH || 1)) * (zoom * vh),
    };
  }

  /** True if the world-space point is inside any visible attachment polygon. */
  _pointInSkeleton(wx, wy) {
    const skeleton = this.skeleton;
    const runtime = this.runtime;
    if (!skeleton || !runtime) return false;
    if (skeleton.color && skeleton.color.a <= 0) return false;

    const isRegion = (a) => runtime.RegionAttachment && a instanceof runtime.RegionAttachment;
    const isMesh = (a) =>
      (runtime.MeshAttachment && a instanceof runtime.MeshAttachment) ||
      (runtime.SkinnedMeshAttachment && a instanceof runtime.SkinnedMeshAttachment);

    let world = null;
    for (const slot of skeleton.slots) {
      if (!slot.bone || !slot.bone.active) continue;
      const attachment = slot.getAttachment ? slot.getAttachment() : slot.attachment;
      if (!attachment) continue;
      if (slot.color && slot.color.a <= 0) continue;

      let vertexCount = 0;
      if (isRegion(attachment)) {
        if (!world) world = new Float32Array(8);
        attachment.computeWorldVertices(slot, world, 0, 2);
        vertexCount = 4;
      } else if (isMesh(attachment)) {
        const count = attachment.worldVerticesLength || 0;
        if (count < 6) continue;
        if (!world || world.length < count) world = new Float32Array(count);
        attachment.computeWorldVertices(slot, 0, count, world, 0, 2);
        vertexCount = count / 2;
      } else {
        continue; // bounding box / path / point / clipping — not rendered
      }
      if (pointInPolygon(wx, wy, world, vertexCount)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Teardown
   * ------------------------------------------------------------------ */

  _disposeModel() {
    if (this.videoEl) {
      try {
        this.videoEl.pause();
        this.videoEl.removeAttribute("src");
        this.videoEl.load();
        this.videoEl.remove();
      } catch (err) {
        console.warn("video dispose failed:", err);
      }
      this.videoEl = null;
    }
    this.gifCanvas = null;
    this.gifFrames = null;
    this.gifTime = 0;
    this.gifIndex = 0;
    this.gifTotal = 0;
    this.gifLastTick = 0;
    if (this.live2d) {
      try {
        this.live2d.dispose();
      } catch (err) {
        console.warn("live2d dispose failed:", err);
      }
      this.live2d = null;
    }
    this.texture = null;
    this.kind = "spine";
    if (this.atlas) {
      for (const page of this.atlas.pages) {
        if (page.texture && typeof page.texture.dispose === "function") {
          try {
            page.texture.dispose();
          } catch (err) {
            console.warn("texture dispose failed:", err);
          }
        }
      }
      this.atlas = null;
    }
    this.skeleton = null;
    this.state = null;
    this.stateData = null;
    this.camera = null;
    this.runtime = null;
    this.runtimeName = null;
    this.animationNames = [];
    this.currentAnimation = null;
    this.playing = false;
    this.paused = false;
    this._clickActive = false;
  }

  dispose() {
    this._loadToken++;
    this._disposeModel();
  }

  _setStatus(message) {
    if (this.onStatus) this.onStatus(message);
  }
}

/* ------------------------------------------------------------------ *
 * SpinePlayer — self-contained player (own canvas), used for thumbnails
 * ------------------------------------------------------------------ */

export class SpinePlayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.renderer = null;
    this.model = new SpineModel();
    this._raf = 0;
    this._lastTime = 0;
    this._disposed = false;
    this.onStatus = null;
    this.onAnimationsChanged = null;
    this.model.onStatus = (msg) => this.onStatus && this.onStatus(msg);
    this.model.onAnimationsChanged = (names, sel) =>
      this.onAnimationsChanged && this.onAnimationsChanged(names, sel);
  }

  async load(entry) {
    this._initGL();
    this.model.gl = this.gl;
    await this.model.load(entry);
    this.resize();
    this._startLoop();
  }

  _initGL() {
    if (this.gl) return;
    const gl =
      this.canvas.getContext("webgl", WEBGL_OPTS) ||
      this.canvas.getContext("experimental-webgl", WEBGL_OPTS);
    if (!gl) throw new Error("WebGL is not supported in this browser.");
    this.gl = gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _createRenderer() {
    if (!this.model.runtime) return;
    const ManagedWebGLRenderingContext = this.model.runtime.ManagedWebGLRenderingContext;
    const context = new ManagedWebGLRenderingContext(this.gl);
    this.renderer = new this.model.runtime.SceneRenderer(this.canvas, context);
  }

  resize() {
    if (!this.model.runtime) return;
    if (!this.renderer) this._createRenderer();
    if (!this.renderer) return;
    this.renderer.resize(this.model.runtime.ResizeMode.Expand);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.model.layout(w, h, w, h, w / 2, h / 2); // single sprite fills the canvas
  }

  _startLoop() {
    if (this._raf || this._disposed) return;
    this._lastTime = performance.now();
    const tick = (now) => {
      if (!this._raf || this._disposed) return;
      const delta = Math.min((now - this._lastTime) / 1000, 0.1);
      this._lastTime = now;
      this.model.update(delta);
      this._render();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _render() {
    if (!this.gl || !this.renderer || !this.model.skeleton) return;
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.model.draw(this.renderer);
  }

  // Delegate playback API to the model.
  get animationNames() {
    return this.model.animationNames;
  }
  get currentAnimation() {
    return this.model.currentAnimation;
  }
  get skeleton() {
    return this.model.skeleton;
  }
  get state() {
    return this.model.state;
  }
  get speed() {
    return this.model.speed;
  }
  get loop() {
    return this.model.loop;
  }
  get paused() {
    return this.model.paused;
  }
  get playing() {
    return this.model.playing;
  }
  get loadId() {
    return this.model.loadId;
  }
  setAnimation(name, loop) {
    return this.model.setAnimation(name, loop);
  }
  togglePause() {
    return this.model.togglePause();
  }
  restart() {
    return this.model.restart();
  }
  setLoop(loop) {
    this.model.setLoop(loop);
  }
  setSpeed(speed) {
    this.model.setSpeed(speed);
  }
  startClickAnimation(name) {
    return this.model.startClickAnimation(name);
  }
  stopClickAnimation() {
    return this.model.stopClickAnimation();
  }
  hitTest(x, y) {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return this.model.hitTest(x, y, w, h);
  }

  _disposeModel() {
    this._raf && cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.model.dispose();
    if (this.renderer) {
      try {
        this.renderer.dispose();
      } catch (err) {
        console.warn("renderer dispose failed:", err);
      }
      this.renderer = null;
    }
  }

  dispose() {
    this._disposed = true;
    this._loadToken && this.model.dispose();
    this._disposeModel();
  }

  canvasPixels() {
    if (!this.gl) return null;
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!w || !h) return null;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let drawn = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) drawn++;
    return { w, h, drawn, total: w * h };
  }
}

/* ------------------------------------------------------------------ *
 * StageRenderer — many models on one shared canvas
 * ------------------------------------------------------------------ */

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    /** runtime -> { renderer, runtime } — one SceneRenderer per runtime. */
    this.renderers = new Map();
    /** SpineModels in stable insertion order. */
    this.models = [];
    /** SpineModels in z-order — later drawn on top ("last moved" wins). */
    this._drawOrder = [];
    this._raf = 0;
    this._lastTime = 0;
    this._disposed = false;
  }

  _ensureGL() {
    if (this.gl) return;
    const gl =
      this.canvas.getContext("webgl", WEBGL_OPTS) ||
      this.canvas.getContext("experimental-webgl", WEBGL_OPTS);
    if (!gl) throw new Error("WebGL is not supported in this browser.");
    this.gl = gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _rendererFor(runtime) {
    let entry = this.renderers.get(runtime);
    if (!entry) {
      const ManagedWebGLRenderingContext = runtime.ManagedWebGLRenderingContext;
      const context = new ManagedWebGLRenderingContext(this.gl);
      const renderer = new runtime.SceneRenderer(this.canvas, context);
      // Size the renderer to the canvas immediately: a freshly created
      // SceneRenderer otherwise keeps the default 300×150 backing store until
      // the next resize(), which never arrives for a single-sprite scene.
      renderer.resize(runtime.ResizeMode.Expand);
      entry = { renderer, runtime };
      this.renderers.set(runtime, entry);
    }
    return entry.renderer;
  }

  addModel(model) {
    this._ensureGL();
    model.gl = this.gl;
    this.models.push(model);
    this._drawOrder.push(model);
    this.resize();
    this._startLoop();
  }

  removeModel(model) {
    const i = this.models.indexOf(model);
    if (i >= 0) this.models.splice(i, 1);
    const di = this._drawOrder.indexOf(model);
    if (di >= 0) this._drawOrder.splice(di, 1);
    model.dispose();
    this.resize();
    if (!this.models.length) this._stopLoop();
  }

  /**
   * Move a model to the top of its OWN layer (rendered last within the layer).
   * Layers stack by the order given to applyLayerOrder(); a sprite can never
   * pass over sprites in a higher layer.
   */
  bringToFront(model) {
    const i = this._drawOrder.indexOf(model);
    if (i < 0) return;
    const layer = model.layer;
    // Find the contiguous run of models in the same layer (the draw order is
    // kept grouped per layer by applyLayerOrder()).
    let runStart = i;
    let runEnd = i;
    while (runStart > 0 && this._drawOrder[runStart - 1].layer === layer) runStart--;
    while (runEnd < this._drawOrder.length - 1 && this._drawOrder[runEnd + 1].layer === layer) runEnd++;
    if (i === runEnd) return; // already top of its layer
    this._drawOrder.splice(i, 1);
    this._drawOrder.splice(runEnd, 0, model);
  }

  /**
   * Rebuild the draw order from a bottom→top list of layer ids, preserving the
   * relative (last-moved) order of the models within each layer.
   */
  applyLayerOrder(layerIds) {
    const ordered = [];
    for (const layerId of layerIds) {
      for (const m of this._drawOrder) {
        if (m.layer === layerId) ordered.push(m);
      }
    }
    // Any model whose layer is missing from the list goes on top (fallback).
    for (const m of this._drawOrder) {
      if (!ordered.includes(m)) ordered.push(m);
    }
    this._drawOrder = ordered;
  }

  /** Models in z-order, bottom to top (topmost last). */
  drawOrder() {
    return this._drawOrder.slice();
  }

  /**
   * Replace the z-order. `models` must be a permutation of the current models;
   * invalid input is ignored so a stale save can't corrupt the stage.
   */
  setDrawOrder(models) {
    if (!Array.isArray(models) || models.length !== this.models.length) return;
    const set = new Set(models);
    if (set.size !== this.models.length) return;
    for (const m of this.models) {
      if (!set.has(m)) return;
    }
    this._drawOrder = models.slice();
  }

  resize() {
    if (!this.gl) return;
    for (const { renderer, runtime } of this.renderers.values()) {
      renderer.resize(runtime.ResizeMode.Expand);
    }
    this._layoutAll();
  }

  /**
   * Position every model. There is NO automatic equal-width row and NO
   * automatic re-fit: a sprite that has never been touched is given ONE
   * default centred fit when its bounds first become available, which is then
   * frozen into canvas fractions (x/y centre + fw/fh size) exactly like a
   * user-pinned sprite. From then on (siblings added/removed, window resized)
   * every sprite keeps its own layout and only scales proportionally with the
   * canvas. Users arrange sprites explicitly in edit mode.
   */
  _layoutAll() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    for (const m of this.models) {
      const cfg = m.layoutConfig || {};
      const x = cfg.x != null ? cfg.x : 0.5;
      const y = cfg.y != null ? cfg.y : 0.5;
      if (cfg.fw != null && cfg.fh != null) {
        // Pinned (user-moved/resized, or the frozen default below): fixed
        // fractions — the sprite never re-flows and never refits.
        m.layoutPinned(w, h, x * w, y * h, cfg.fw * w, cfg.fh * h, cfg.scale || 1);
        continue;
      }
      if (!m.skeleton || !m.camera) continue; // still loading — retried on the next resize
      // Never-touched sprite: fit it once to the canvas (the classic
      // single-sprite look), then freeze that fit into fractions.
      m.layout(w, h, w, h, x * w, y * h, cfg.scale || 1);
      const r = m.modelRect(w, h);
      if (r) {
        const cx = (r.left + r.right) / (2 * w);
        cfg.x = m.mirror ? 1 - cx : cx;
        cfg.y = (r.top + r.bottom) / (2 * h);
        cfg.fw = (r.right - r.left) / w;
        cfg.fh = (r.bottom - r.top) / h;
        cfg.scale = 1; // size is now captured by fw/fh
      }
    }
  }

  _startLoop() {
    if (this._raf || this._disposed) return;
    this._lastTime = performance.now();
    const tick = (now) => {
      if (!this._raf || this._disposed) return;
      const delta = Math.min((now - this._lastTime) / 1000, 0.1);
      this._lastTime = now;
      this._frame(now, delta);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopLoop() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  _frame(now, delta) {
    if (!this.gl) return;
    const gl = this.gl;
    // Cubism's mask rendering mutates gl.clearColor (white) without restoring
    // it — reassert transparent before each clear or the stage turns white.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const model of this._drawOrder) {
      model.update(delta);
      // GIF sprites advance on wall clock (robust to rAF throttling).
      if (model.kind === "gif") model.gifTick(now || performance.now());
      // Live2D sprites render into their own offscreen Cubism canvas each
      // frame; the canvas is then re-uploaded as the sprite texture below.
      if (model.kind === "live2d") model.live2d?.render();
      // Refresh animated media textures every frame before drawing: <video>
      // frames, the GIF canvas, and the Live2D offscreen canvas.
      const animatedSource =
        model.kind === "video"
          ? model.videoEl
          : model.kind === "gif"
            ? model.gifCanvas
            : model.kind === "live2d"
              ? model.live2d?.canvas ?? null
              : null;
      if (model.texture && animatedSource) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        try {
          model.texture.update(false);
        } finally {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        }
      }
      const renderer = model.runtime ? this._rendererFor(model.runtime) : null;
      if (renderer) model.draw(renderer);
    }
  }

  /** Draw one frame synchronously (tests / screenshots). */
  renderOnce() {
    this._frame(0, 0);
  }

  /** Topmost model under a canvas-relative CSS-pixel point, or null. */
  hitTest(x, y) {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    for (let i = this._drawOrder.length - 1; i >= 0; i--) {
      if (this._drawOrder[i].hitTest(x, y, w, h)) return this._drawOrder[i];
    }
    return null;
  }

  canvasPixels() {
    if (!this.gl) return null;
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!w || !h) return null;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let drawn = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) drawn++;
    return { w, h, drawn, total: w * h };
  }

  /** Colour-weighted sum over the whole framebuffer — a cheap signature that
   *  changes whenever ANY pixel changes (used to detect animation). */
  pixelSignature() {
    if (!this.gl) return null;
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!w || !h) return null;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) {
      sum += buf[i] * 3 + buf[i + 1] * 5 + buf[i + 2] * 7;
    }
    return sum;
  }

  dispose() {
    this._disposed = true;
    this._stopLoop();
    for (const { renderer } of this.renderers.values()) {
      try {
        renderer.dispose();
      } catch (err) {
        console.warn("stage renderer dispose failed:", err);
      }
    }
    this.renderers.clear();
    for (const m of this.models) m.dispose();
    this.models = [];
    this._drawOrder = [];
  }
}
