/**
 * audio-snippet-editor.js — editor-only waveform + trim UI for per-element
 * audio snippets. Wraps wavesurfer.js + its Regions plugin; imported only by
 * the editor entry (src/main.js) — never bundled into the exported wallpaper
 * template (the runtime plays snippets with plain HTMLAudioElement, see
 * SceneController._playSnippet in scene.js).
 *
 * Lifecycle: one SnippetWaveform instance owns the container. load(url,
 * start, end) destroys any previous instance and creates a fresh waveform
 * with one draggable/resizable region; dragging or resizing reports new
 * start/end through the onRegion callback. `update(start, end)` moves the
 * region programmatically (from the numeric inputs) without re-firing the
 * callback, so callers never fight loops.
 */
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";

export class SnippetWaveform {
  /**
   * @param {HTMLElement} container element the waveform is drawn into
   * @param {(start:number, end:number) => void} onRegion user trimmed via drag
   */
  constructor(container, onRegion) {
    this.container = container;
    this.onRegion = onRegion;
    this.ws = null;
    this.regions = null;
    this.fileUrl = null;
    this._resolveLoad = null;
    this._stopPreview = null;
  }

  destroy() {
    this.stopPreview();
    if (this.ws) {
      try {
        this.ws.destroy();
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.regions = null;
      this.fileUrl = null;
    }
  }

  get ready() {
    return !!this.ws;
  }

  /**
   * Load an audio URL and show one region spanning [start, end]. Resolves
   * true once decoded (region added), false on load error.
   * @returns {Promise<boolean>}
   */
  load(url, start = 0, end = null) {
    this.destroy();
    if (!url || !this.container) return Promise.resolve(false);
    // The container must be laid out (not display:none) for a useful decode.
    if (this.container.clientWidth < 4 || this.container.clientHeight < 2) {
      return Promise.resolve(false);
    }
    this.fileUrl = url;
    let ws;
    try {
      ws = WaveSurfer.create({
        container: this.container,
        url,
        height: Math.max(24, this.container.clientHeight || 56),
        waveColor: "rgba(158, 180, 204, 0.9)",
        progressColor: "rgba(255, 165, 90, 0.95)",
        cursorColor: "transparent",
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
      });
    } catch {
      return Promise.resolve(false);
    }
    this.ws = ws;
    const regions = ws.registerPlugin(RegionsPlugin.create());
    this.regions = regions;

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      this._resolveLoad?.(ok);
      this._resolveLoad = null;
    };

    regions.on("region-update", (region) => this._report(region));
    regions.on("region-updated", (region) => this._report(region));

    ws.once("decode", () => {
      const dur = ws.getDuration() || 0;
      const s = Math.max(0, Math.min(start ?? 0, dur));
      const e = end != null ? Math.max(Math.min(end, dur), s) : dur;
      // A zero-length region is a marker; keep at least a sliver so it is
      // grabbable, unless the whole file is under that sliver.
      const regionEnd = dur > 0.1 ? Math.max(e, Math.min(dur, s + 0.02)) : e;
      const regionStart = dur > 0.1 ? Math.min(s, Math.max(0, dur - 0.01)) : s;
      if (regions.getRegions().length === 0) {
        regions.addRegion({
          start: regionStart,
          end: regionEnd,
          color: "rgba(255, 140, 60, 0.3)",
          drag: true,
          resize: true,
          minLength: 0.02,
        });
      }
      finish(true);
    });
    ws.once("error", () => finish(false));

    return new Promise((resolve) => {
      this._resolveLoad = resolve;
    });
  }

  /** Move the region to [start, end] without reporting back (input sync). */
  update(start, end) {
    const region = this.regions?.getRegions()[0];
    if (!region || !this.ws) return;
    const dur = this.ws.getDuration() || 0;
    const s = Math.max(0, Math.min(start ?? 0, dur));
    const e = end != null ? Math.max(Math.min(end, dur), Math.min(s + 0.02, dur)) : dur;
    region.setOptions({ start: Math.min(s, Math.max(0, dur - 0.01)), end: e });
  }

  _report(region) {
    if (!this.ws) return;
    const dur = this.ws.getDuration() || 0;
    const s = Math.max(0, Math.min(region.start, dur || region.start));
    const e = region.end != null ? Math.min(region.end, dur) : dur;
    if (this.onRegion && e - s > 0.005) this.onRegion(s, e);
  }

  /** Audition the region through wavesurfer (visual + audible). */
  preview() {
    const region = this.regions?.getRegions()[0];
    if (!region || !this.ws) return;
    const { start, end } = region;
    this.stopPreview();
    this.ws.setTime(start);
    this.ws.play();
    const stop = this.ws.on("timeupdate", (t) => {
      if (end != null && t >= end) this.stopPreview();
    });
    this._stopPreview = typeof stop === "function" ? stop : () => this.ws?.pause?.();
  }

  stopPreview() {
    if (this.ws && !this.ws.isDestroyed?.()) {
      try {
        this.ws.pause();
      } catch {
        /* ignore */
      }
    }
    if (this._stopPreview) {
      try {
        this._stopPreview();
      } catch {
        /* ignore */
      }
      this._stopPreview = null;
    }
  }

  /** Total decoded duration in seconds, or null before decode. */
  get duration() {
    return this.ws?.getDuration?.() ?? null;
  }
}
