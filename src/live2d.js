/**
 * live2d.js — Live2D/Cubism runtime integration (user-provided, never shipped).
 *
 * The Cubism SDK is loaded dynamically from the relative cubism/ path at first
 * use (scripts injected, then globals verified). Each Live2DModel renders its
 * .model3.json model into its OWN offscreen WebGL canvas using the official
 * Cubism pipeline (so clipping masks behave exactly like the SDK sample), and
 * that canvas is then composited by the shared stage through the same
 * single-region-skeleton texture path used for image/video/GIF sprites — which
 * gives correct layout, drag/resize, mirror, tint and hit-testing for free.
 *
 * Without the runtime, load() fails and the sprite degrades to a non-fatal
 * placeholder.
 */
let runtimePromise = null;

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load Cubism script: ${src}`));
    document.head.appendChild(s);
  });
}

/** Inject Core + Framework and verify their globals (memoized). */
export function ensureCubismRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (window.Live2DCubismCore && window.Live2DCubismFramework) {
        return window.Live2DCubismFramework;
      }
      if (!window.Live2DCubismCore) {
        await injectScript("cubism/Core/live2dcubismcore.min.js");
      }
      if (!window.Live2DCubismFramework) {
        await injectScript("cubism/Framework/live2d.min.js");
      }
      if (!window.Live2DCubismCore || !window.Live2DCubismFramework) {
        throw new Error("Cubism runtime is not installed (see vendor/cubism/README.md)");
      }
      return window.Live2DCubismFramework;
    })().catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

let frameworkStarted = false;
function startFramework(F) {
  if (frameworkStarted) return;
  F.CubismFramework.startUp();
  F.CubismFramework.initialize();
  frameworkStarted = true;
}

/** Cap the offscreen canvas long edge to bound per-sprite texture memory. */
const MAX_CANVAS_EDGE = 1024;

export class Live2DModel {
  constructor() {
    this.F = null;
    this.user = null;
    this.setting = null;
    this.ready = false;
    this.canvas = null; // offscreen canvas (own WebGL context)
    this.gl = null;
    this.canvasW = 0; // offscreen canvas width (px)
    this.canvasH = 0; // offscreen canvas height (px)
    this.loadId = 0;
    this.onStatus = null;
    this._token = 0;
    this._textures = [];
    this._modelDir = "";
    this._mvp = null; // CubismMatrix44 (model matrix folded in), computed once
    // Motion catalog (see _scanMotionCatalog): every motion file of the model
    // with UI-facing names, plus the inferred ambient/click defaults. The
    // motions become the sprite's "animations" (like Spine skeleton
    // animations) so the editor panels and click/hold behaviour work the same.
    this.animCatalog = [];
    this.animNames = [];
    this.defaultIdleName = null; // ambient motion (usually an idle file/group)
    this.defaultClickName = null; // press reaction motion (touch/tap/…), or null
    this._mainName = null; // catalog name of the ambient motion
    this._mainMotion = null; // CubismMotion of the ambient motion
    this._clickMotion = null; // CubismMotion of the held click motion
    this._clickActive = false; // true while a click motion is held
    this._motionCache = new Map(); // name -> Promise<CubismMotion|null>
    this.currentAnimation = null; // catalog name of the last started motion
    this.paused = false; // freeze motion stepping (mirrored on the SpineModel)
  }

  _setStatus(msg) {
    if (this.onStatus) this.onStatus(msg);
  }

  /** Load a .model3.json model and prepare its offscreen renderer. */
  async load(url) {
    const token = ++this._token;
    this._setStatus("Loading Live2D model…");
    try {
      const F = await ensureCubismRuntime();
      if (token !== this._token) return;
      this.F = F;
      startFramework(F);
      this._modelDir = url.slice(0, url.lastIndexOf("/") + 1);

      const settingRes = await fetch(url);
      if (!settingRes.ok) throw new Error(`Cannot fetch ${url} (HTTP ${settingRes.status})`);
      const settingBuf = await settingRes.arrayBuffer();
      if (token !== this._token) return;
      const setting = new F.CubismModelSettingJson(settingBuf, settingBuf.byteLength);
      this.setting = setting;

      const mocName = setting.getModelFileName();
      if (!mocName) throw new Error(`${url}: no model (.moc3) referenced`);
      const mocRes = await fetch(this._modelDir + mocName);
      if (!mocRes.ok) throw new Error(`Cannot fetch ${this._modelDir}${mocName}`);
      const mocBuf = await mocRes.arrayBuffer();
      if (token !== this._token) return;

      this._disposeUserModel();
      const user = new F.CubismUserModel();
      this.user = user;
      user.loadModel(mocBuf, mocBuf.byteLength, false);
      const model = user.getModel();
      if (!model) throw new Error(`${mocName}: failed to load .moc3`);

      // Pose + physics (optional but required for correctness): models that
      // carry a .pose3.json keep mutually-exclusive part variants (e.g. arms
      // folded vs arms down) under a Part opacity group defined there — without
      // loading AND stepping CubismPose every frame, both variants render at
      // full opacity stacked on each other.
      const poseFile = setting.getPoseFileName();
      const physicsFile = setting.getPhysicsFileName();
      const [poseRes, physicsRes] = await Promise.all([
        poseFile
          ? fetch(this._modelDir + poseFile).then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(0)))
          : Promise.resolve(null),
        physicsFile
          ? fetch(this._modelDir + physicsFile).then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(0)))
          : Promise.resolve(null),
      ]);
      if (poseRes && poseRes.byteLength) user.loadPose(poseRes, poseRes.byteLength);
      if (physicsRes && physicsRes.byteLength) user.loadPhysics(physicsRes, physicsRes.byteLength);
      if (token !== this._token) return;

      // Build the motion catalog and start the model's ambient motion,
      // letting it settle a few frames FIRST so the measured bounds + canvas
      // aspect describe the visible idle pose (the setup pose can be much
      // wider — e.g. arms out — than the character).
      this._scanMotionCatalog(setting);
      await this._startAmbientMotion();
      if (token !== this._token) return;
      for (let f = 0; f < 20; f++) {
        model.loadParameters();
        if (user._motionManager.isFinished() && this._mainMotion) {
          user._motionManager.startMotionPriority(this._mainMotion, false, 3);
        }
        user._motionManager.updateMotion(model, 0.05);
        model.saveParameters();
        model.update();
      }

      this._bounds = this._measureBounds(model);
      if (!this._bounds) throw new Error(`${mocName}: could not measure model bounds`);

      // Offscreen canvas: match the measured bounds ASPECT (the moc's vertex
      // unit magnitude is irrelevant — it may be normalized or pixel-sized),
      // with the long edge capped for bounded texture memory.
      const ratio = this._bounds.cw / this._bounds.ch; // width / height
      if (ratio >= 1) {
        this.canvasW = MAX_CANVAS_EDGE;
        this.canvasH = Math.max(4, Math.round(MAX_CANVAS_EDGE / ratio));
      } else {
        this.canvasH = MAX_CANVAS_EDGE;
        this.canvasW = Math.max(4, Math.round(MAX_CANVAS_EDGE * ratio));
      }

      const canvas = document.createElement("canvas");
      canvas.width = this.canvasW;
      canvas.height = this.canvasH;
      // preserveDrawingBuffer:true — the composite samples this canvas as a
      // texture each frame; without it the browser may clear the buffer after
      // compositing, which causes stale/ghosted frames (e.g. doubled arms).
      const gl = canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error("WebGL unavailable for Live2D offscreen canvas");
      this.canvas = canvas;
      this.gl = gl;

      this._setStatus("Preparing Live2D renderer…");
      user.createRenderer(this.canvasW, this.canvasH);
      const renderer = user.getRenderer();
      renderer.startUp(gl);
      renderer.loadShaders("cubism/Shaders/WebGL/");
      renderer.setIsPremultipliedAlpha(true);

      await this._loadTextures(setting, user, renderer);
      if (token !== this._token) return;

      // MVP (column-major) with uniform PIXEL scale k fitted to the canvas.
      // NDC is square while the offscreen canvas is not, so the X and Y NDC
      // factors differ (sx = 2k/canvasW, sy = 2k/canvasH) — that is what
      // keeps the model undistorted on a non-square canvas.
      const b = this._bounds;
      const k = Math.min(this.canvasW / b.cw, this.canvasH / b.ch) * 0.96;
      const sx = (2 * k) / this.canvasW;
      const sy = (2 * k) / this.canvasH;
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const mvp = new F.CubismMatrix44();
      mvp.setMatrix(new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -cx * sx, -cy * sy, 0, 1]));
      this._mvp = mvp;

      this.ready = true;
      this._setStatus(`Loaded Live2D ${url}`);
      this.loadId++;
    } catch (err) {
      if (token === this._token) {
        console.error("[Live2DModel] load failed:", err);
        this._setStatus(`Error: ${err.message}`);
        this.ready = false;
        this.loadId++;
        throw err;
      }
    }
  }

  async _loadTextures(setting, user, renderer) {
    const gl = this.gl;
    const count = setting.getTextureCount();
    for (let i = 0; i < count; i++) {
      const name = setting.getTextureFileName(i);
      if (!name) continue;
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(`Cannot load texture ${name}`));
        im.src = this._modelDir + name;
      });
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._textures.push(tex);
      renderer.bindTexture(i, tex);
    }
  }

  /** Measure the model's vertex bounds across all drawables (current pose). */
  _measureBounds(model) {
    const dc = model.getDrawableCount();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < dc; i++) {
      const v = model.getDrawableVertices(i);
      for (let j = 0; j < v.length; j += 2) {
        const x = v[j];
        const y = v[j + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX) || minX >= maxX || minY >= maxY) return null;
    return { minX, minY, maxX, maxY, cw: maxX - minX, ch: maxY - minY };
  }

  /**
   * Enumerate every motion of the model into a flat catalog with UI-facing
   * names and infer the defaults — no assumptions about specific models:
   *   - idle name:  first motion whose group or file stem suggests the ambient
   *                 loop (idle / wait / stand / loop / breath / normal …),
   *                 falling back to the first motion so every model animates
   *   - click name: first motion whose group or file stem suggests a tap /
   *                 touch / click / press reaction, or null when none exists
   * Real-world exports differ: many put every motion under one unnamed group
   * with the file names carrying the semantics (idle.motion3.json,
   * touch1.motion3.json, …); grouped exports name their groups (an "Idle"
   * group, a "TapBody" group, …). Duplicate stems across groups get a
   * "group/stem" name so catalog names stay unique and stable for persistence.
   */
  _scanMotionCatalog(setting) {
    const catalog = [];
    const stems = new Map(); // stem -> how many times seen (disambiguation)
    const groupCount = setting.getMotionGroupCount();
    for (let gi = 0; gi < groupCount; gi++) {
      const group = setting.getMotionGroupName(gi);
      const count = setting.getMotionCount(group);
      for (let mi = 0; mi < count; mi++) {
        const file = setting.getMotionFileName(group, mi);
        if (!file) continue;
        const stem = String(file.slice(file.lastIndexOf("/") + 1)).replace(/\.motion3\.json$/i, "");
        let name = stem || `motion-${catalog.length}`;
        const n = stems.get(name) ?? 0;
        if (n > 0) name = group ? `${group}/${stem}` : `${stem}-${n + 1}`;
        stems.set(stem, n + 1);
        catalog.push({ name, stem, group, file, index: mi });
      }
    }
    this.animCatalog = catalog;
    this.animNames = catalog.map((m) => m.name);
    const pick = (reStem, reGroup) => {
      for (const m of catalog) {
        if (m.group && reGroup.test(m.group)) return m.name;
        if (reStem.test(m.stem)) return m.name;
      }
      return null;
    };
    this.defaultIdleName =
      pick(/idle|wait|stand|loop|breath|normal/i, /idle|wait|stand|loop|breath|normal/i) ??
      catalog[0]?.name ??
      null;
    this.defaultClickName = pick(/touch|tap|click|press|hit/i, /tap|touch|click|press|hit/i);
  }

  /**
   * Start the ambient motion, preferring the inferred idle one but falling
   * back through the catalog so a single motion the runtime cannot play (a
   * corrupt/unsupported .motion3.json in an otherwise fine model) never
   * leaves the sprite frozen.
   */
  async _startAmbientMotion() {
    const preferred = this.defaultIdleName ?? this.animNames[0] ?? null;
    const order = preferred ? [preferred, ...this.animNames.filter((n) => n !== preferred)] : this.animNames;
    for (const name of order) {
      if (await this.setMainAnimation(name)) return true;
    }
    if (this.animNames.length) {
      console.warn("[Live2DModel] none of the model's motions could be started");
    }
    return false;
  }

  /** Load a motion by catalog name (memoized); resolves null on failure. */
  _getMotion(name) {
    if (this._motionCache.has(name)) return this._motionCache.get(name);
    const entry = this.animCatalog.find((m) => m.name === name);
    const promise = (async () => {
      if (!entry || !this.user || !this.setting) return null;
      const res = await fetch(this._modelDir + entry.file);
      if (!res.ok) throw new Error(`Cannot fetch motion ${entry.file} (HTTP ${res.status})`);
      const buf = await res.arrayBuffer();
      const motion = this.user.loadMotion(
        buf,
        buf.byteLength,
        null,
        null,
        null,
        this.setting,
        entry.group,
        entry.index
      );
      if (!motion) return null;
      motion.setEffectIds([], []);
      return motion;
    })().catch((err) => {
      console.warn(`[Live2DModel] motion "${name}" failed to load:`, err);
      return null;
    });
    this._motionCache.set(name, promise);
    return promise;
  }

  /** Set the ambient (main/looping) motion by catalog name and start it
   *  unless a click motion is currently held (it takes effect on release). */
  async setMainAnimation(name) {
    const motion = await this._getMotion(name);
    if (!motion) return false;
    this._mainName = name;
    this._mainMotion = motion;
    this.currentAnimation = name;
    if (!this._clickActive && this.user) {
      this.user._motionManager.startMotionPriority(motion, false, 3);
    }
    return true;
  }

  /** Start a reaction motion while the sprite is pressed (kept going until
   *  released). Returns false when the name is unknown/unloadable. */
  async startClickAnimation(name) {
    const motion = await this._getMotion(name);
    if (!motion) return false;
    this._clickMotion = motion;
    this._clickActive = true;
    if (this.user) this.user._motionManager.startMotionPriority(motion, false, 3);
    return true;
  }

  /** End the held click motion and return to the ambient motion. */
  stopClickAnimation() {
    this._clickActive = false;
    this._clickMotion = null;
    if (!this.user) return;
    if (this._mainMotion) this.user._motionManager.startMotionPriority(this._mainMotion, false, 3);
  }

  /** Restart the ambient motion from its beginning (Restart button). */
  restartMain() {
    if (!this.user || !this._mainMotion) return false;
    this.user._motionManager.startMotionPriority(this._mainMotion, false, 3);
    return true;
  }

  /** Advance motion and model state by delta seconds. */
  update(delta) {
    if (!this.ready || !this.user) return;
    if (this.paused) return; // frozen while paused; resuming simply continues
    const user = this.user;
    const model = user.getModel();
    model.loadParameters();
    const manager = user._motionManager;
    if (manager.isFinished()) {
      // Loop the ambient motion; while a click is held, keep the click motion
      // going instead (a one-shot reaction motion restarts until released).
      const next = this._clickActive ? this._clickMotion : this._mainMotion;
      if (next) manager.startMotionPriority(next, false, 3);
    }
    manager.updateMotion(model, delta);
    model.saveParameters();
    // Physics then Pose, in this order, AFTER the motion has set parameter
    // values and BEFORE model.update() — this is what resolves Part-opacity
    // groups (the losing part variant fades out).
    if (user._physics) user._physics.evaluate(model, delta);
    if (user._pose) user._pose.updateParameters(model, delta);
    model.update();
  }

  /** Draw the model into its own offscreen canvas (called by the stage). */
  render() {
    if (!this.ready || !this.user || !this.gl) return;
    const gl = this.gl;
    // Cubism's mask passes bind FBOs and can enable scissor — reset both so
    // the clear below always wipes the whole canvas (prevents frame
    // accumulation / ghosting between renders).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvasW, this.canvasH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.user.getRenderer().setMvpMatrix(this._mvp);
    this.user.getRenderer().drawModel();
  }

  _disposeUserModel() {
    if (this.user) {
      try {
        this.user.release();
      } catch (err) {
        console.warn("Live2D model release failed:", err);
      }
      this.user = null;
    }
    if (this.gl) {
      for (const tex of this._textures) {
        try {
          this.gl.deleteTexture(tex);
        } catch {
          /* ignore */
        }
      }
    }
    this._textures = [];
    this._mainMotion = null;
    this._clickMotion = null;
    this._clickActive = false;
    this._motionCache = new Map();
    this._mvp = null;
  }

  dispose() {
    this._token++;
    this._disposeUserModel();
    this.ready = false;
    this.canvas = null;
    this.gl = null;
  }
}
