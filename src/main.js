/**
 * main.js — editor UI wiring for the Spine viewer.
 *
 * This is the full configurator: scene management (create / switch / rename /
 * delete), character + custom-asset picker, variant / animation / click /
 * playback / audio / background controls, layers, edit mode (drag / resize /
 * remove), aspect-ratio guides and a fullscreen preview. All scene state
 * lives in SceneController (src/scene.js); this file is only the UI layer and
 * keeps that state in sync by subscribing to the controller's events.
 *
 * The clean wallpaper renderer (no UI) is src/wallpaper.js.
 */
import { SceneController, MAX_SPRITES, defaultClickAnimation, defaultVariant } from "./scene.js";
import { Thumbnailer } from "./thumbnailer.js";
import { loadCharacters } from "./manifest-loader.js";
import { SPEEDS } from "./spine-player.js";
import { saveAudioUpload, deleteAudioUpload, listAudioUploads } from "./audio.js";
import { SnippetWaveform } from "./audio-snippet-editor.js";

// The picker's "content folder" control remembers its choice under this key;
// it is re-applied to the server on every boot BEFORE the manifest is fetched
// so the library reflects the folder the user last chose.
const CONTENT_FOLDER_KEY = "lwpg.contentRoot";

// Dynamic manifest: prefers the dev server's /api/manifest (scans the current
// content root on every request), falls back to the bundled src/manifest.js.
await applyPersistedContentRoot();
const CHARACTERS = await loadCharacters();

// The picker's tabs/subtabs are generated from the library folders each asset
// was found in (see scripts/scan-assets.mjs): top-level content folders →
// tabs, their immediate subfolders → subtabs, items sitting at a tab root
// stay at tab level. The manifest only tags every entry with `tab`/`subtab`;
// the tree below is derived from those, so any folder layout works with no
// hard-coded tab names or catalogue-specific grouping.
function folderLabel(name) {
  return String(name || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// PICKER_TABS: [{ name, label, views: [{ key: subtabName|null, label, chars }] }]
const PICKER_TABS = [];
const PICKER_TAB_INDEX = new Map();
for (const c of CHARACTERS) {
  // `tab`/`subtab` come from the folder scanner; a fallback keeps older
  // bundled manifests (pre-folder-layout) usable as a single flat tab.
  const tabName = c.tab || "library";
  let tab = PICKER_TAB_INDEX.get(tabName);
  if (!tab) {
    tab = { name: tabName, label: folderLabel(tabName), views: [] };
    PICKER_TAB_INDEX.set(tabName, tab);
    PICKER_TABS.push(tab);
  }
  const key = c.subtab ?? null;
  let view = tab.views.find((v) => v.key === key);
  if (!view) {
    view = { key, label: key == null ? null : folderLabel(key), chars: [] };
    tab.views.push(view);
  }
  view.chars.push(c);
}
// Tabs alphabetical; within a tab, named subtabs first (alphabetical), then
// the tab-root items (presented as "Misc" only when the tab also has subtabs).
PICKER_TABS.sort((a, b) => a.name.localeCompare(b.name));
for (const tab of PICKER_TABS) {
  tab.views.sort(
    (a, b) => (a.key == null ? 1 : 0) - (b.key == null ? 1 : 0) || (a.key ?? "").localeCompare(b.key ?? "")
  );
}

/** Label of a subtab button; tab-root items get "Misc" when the tab has real
 *  subtabs, and null (no subtab row) when the tab is flat. */
function viewButtonLabel(tab, view) {
  return view.key != null ? view.label : tab.views.length > 1 ? "Misc" : null;
}

const $ = (id) => document.getElementById(id);

const characterBtn = $("character-btn");
const characterLabel = $("character-label");
const addCharBtn = $("add-char-btn");
const characterCount = $("character-count");
const variantSelect = $("variant-select");
const animationSelect = $("animation-select");
const clickSelect = $("click-select");
const resetBtn = $("reset-btn");
const resetEditsBtn = $("reset-edits-btn");
const panelToggle = $("panel-toggle");
const panelOpen = $("panel-open");
const panelEmpty = $("panel-empty");
const panelContent = $("panel-content");
const scaleRange = $("scale-range");
const scaleValue = $("scale-value");
const opacityRange = $("opacity-range");
const opacityValue = $("opacity-value");
const tintColor = $("tint-color");
const mirrorCheck = $("mirror-check");
const brightnessRange = $("brightness-range");
const brightnessValue = $("brightness-value");
const colorRRange = $("color-r-range");
const colorRValue = $("color-r-value");
const colorGRange = $("color-g-range");
const colorGValue = $("color-g-value");
const colorBRange = $("color-b-range");
const colorBValue = $("color-b-value");
const audioTitle = $("audio-title");
const audioAddBtn = $("audio-add-btn");
const audioUploadInput = $("audio-upload");
const audioCustom = $("audio-custom");
const audioCatWrap = $("audio-cat-wrap");
const audioOptions = $("audio-options");
const audioMute = $("audio-mute");
const audioVolumeRange = $("audio-volume");
const audioSnippetEl = $("audio-snippet");
const snippetFileSel = $("snippet-file");
const snippetWaveEl = $("snippet-wave");
const snippetStartInput = $("snippet-start");
const snippetEndInput = $("snippet-end");
const snippetPreviewBtn = $("snippet-preview");
const snippetClearBtn = $("snippet-clear");
const snippetHint = $("snippet-hint");
const playPauseBtn = $("play-pause-btn");
const restartBtn = $("restart-btn");
const loopCheck = $("loop-check");
const speedSelect = $("speed-select");
const layerSelect = $("layer-select");
const layersBtn = $("layers-btn");
const layersPanel = $("layers-panel");
const layersList = $("layers-list");
const layersNewName = $("layers-new-name");
const layersAddBtn = $("layers-add");
const editToggleBtn = $("edit-btn");
const backgroundSelect = $("background-select");
const backgroundColorInput = $("background-color");
const backgroundFile = $("background-file");
const scenesBtn = $("scenes-btn");
const scenesPanel = $("scenes-panel");
const scenesNewBtn = $("scenes-new");
const scenesList = $("scenes-list");
const guidesSelect = $("guides-select");
const guidesOverlay = $("guides-overlay");
const previewBtn = $("preview-btn");
const previewHint = $("preview-hint");
const exportBtn = $("export-btn");
const openFolderBtn = $("open-folder-btn");
const statusEl = $("status");
const stage = $("stage");
const stageCanvas = $("stage-canvas");

const scene = new SceneController(stageCanvas, stage, CHARACTERS);

const picker = $("picker");
const pickerSearch = $("picker-search");
const pickerTabs = $("picker-tabs");
const pickerSubtabs = $("picker-subtabs");
const pickerGrids = $("picker-grids");
const pickerStatus = $("picker-status");
const pickerClose = $("picker-close");

// Content-folder control (the picker can repoint the library at another
// folder at runtime; the server root is switched via /api/content).
const pickerFolderBtn = $("picker-folder-btn");
const pickerFolderRow = $("picker-folder-row");
const pickerFolderInput = $("picker-folder-input");
const pickerFolderApply = $("picker-folder-apply");
const pickerFolderReset = $("picker-folder-reset");
const pickerFolderStatus = $("picker-folder-status");

const charactersById = scene.charactersById;

/* ------------------------------------------------------------------ *
 * Scene event subscriptions (keep the UI in sync with the scene)
 * ------------------------------------------------------------------ */

scene.on("spriteAdded", () => {
  updateSpriteCounter();
  refreshPickerCells();
});

scene.on("spriteRemoved", (sprite) => {
  if (sprite.overlay) {
    sprite.overlay.remove();
    sprite.overlay = null;
  }
  updateSpriteCounter();
  refreshPickerCells();
});

scene.on("activeChanged", () => syncControlsToActive());

scene.on("status", (sprite, msg) => {
  if (sprite.id === scene.activeSpriteId) statusEl.textContent = msg;
});

scene.on("animationsChanged", (sprite, names, selected) => {
  if (sprite.id === scene.activeSpriteId) {
    onActiveAnimationsChanged(sprite, names, selected, { forceDefault: true });
  }
});

scene.on("settingsApplied", (sprite) => {
  if (sprite.id === scene.activeSpriteId) syncControlsToActive();
});

scene.on("audioReady", (sprite) => {
  if (sprite.id === scene.activeSpriteId) rebuildAudioPanel();
});

scene.on("editsReset", () => {
  updateEditOverlays();
  if (scene.getActiveSprite()) syncControlsToActive();
});

scene.on("bgChanged", () => {
  backgroundSelect.value = scene.bgMode;
  backgroundColorInput.value = scene.bgColor;
  // Keep the current scene record in sync. (The background blob itself is
  // persisted by SceneController.applyBgImage / applyState into the bg DB
  // keyed by this scene's id, so no extra write is needed here.)
  saveCurrentSceneState();
});

scene.on("layersChanged", () => {
  populateLayerSelect();
  rebuildLayersPanel();
  if (scene.getActiveSprite()) syncControlsToActive();
});

/* ------------------------------------------------------------------ *
 * Stage UI helpers
 * ------------------------------------------------------------------ */

function getActiveSprite() {
  return scene.getActiveSprite();
}

function getActivePlayer() {
  return scene.getActivePlayer();
}

function updateSpriteCounter() {
  characterCount.textContent = `Sprites ${scene.sprites.size}/${MAX_SPRITES}`;
}

function resetEdits() {
  scene.resetEdits();
}

/* ------------------------------------------------------------------ *
 * Audio UI helpers
 * ------------------------------------------------------------------ */

function audioButtonLabel(sprite) {
  const total = sprite && sprite.audioEntry ? sprite.audioEntry.categories.size : 0;
  if (!total) return "—";
  const selected = sprite.audioCategories.size;
  return selected === total ? "All" : `${selected}/${total}`;
}

/** Rebuild the panel's Audio section: custom audio list when present, else
 *  the back-compat voice-line category checkboxes. */
function rebuildAudioPanel() {
  const sprite = getActiveSprite();
  const custom = sprite?.audioEntry?.custom || [];
  const hasCatalog =
    !!sprite && !!sprite.audioEntry && !custom.length && sprite.audioEntry.categories.size > 0;

  audioMute.disabled = !sprite;
  audioMute.checked = !!sprite && sprite.muted;

  if (custom.length) audioTitle.textContent = `Audio (${custom.length})`;
  else if (hasCatalog) audioTitle.textContent = `Audio: ${audioButtonLabel(sprite)}`;
  else audioTitle.textContent = "Audio";

  // Custom audio list (files next to the asset / uploaded).
  audioCustom.innerHTML = "";
  audioCustom.classList.toggle("hidden", !custom.length);
  for (const line of custom) {
    const row = document.createElement("div");
    row.className = "audio-item";

    const name = document.createElement("span");
    name.className = "audio-name";
    name.textContent = line.name;
    name.title = line.url;

    const play = document.createElement("button");
    play.type = "button";
    play.className = "audio-play";
    play.textContent = "▶";
    play.title = "Play this audio";
    play.addEventListener("click", () => {
      if (sprite) scene._playAudioUrl(sprite, line.url);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "audio-remove";
    del.textContent = "✕";
    del.title = "Remove this audio file";
    del.addEventListener("click", () => removeCustomAudio(sprite, line));

    row.appendChild(name);
    row.appendChild(play);
    row.appendChild(del);
    audioCustom.appendChild(row);
  }

  // Back-compat: the voice-line catalogue's categories.
  audioCatWrap.classList.toggle("hidden", !hasCatalog);
  audioOptions.innerHTML = "";
  if (hasCatalog) {
    for (const category of sprite.audioEntry.categories.keys()) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = category;
      input.checked = sprite.audioCategories.has(category);
      input.addEventListener("change", () => {
        if (input.checked) sprite.audioCategories.add(category);
        else sprite.audioCategories.delete(category);
        audioTitle.textContent = `Audio: ${audioButtonLabel(sprite)}`;
        scene.persistStage();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(category));
      audioOptions.appendChild(label);
    }
  }
  refreshSnippetEditor();
}

/* ------------------------------------------------------------------ *
 * Audio snippets (editor-only waveform trim)
 * ------------------------------------------------------------------ */

/** One shared waveform (created lazily — the panel can rebuild before this
 *  module's top-level initialisers finish during boot). */
let snippetWave = null;
function snippetEditor() {
  if (!snippetWave) {
    snippetWave = new SnippetWaveform(snippetWaveEl, (start, end) => {
      const sprite = getActiveSprite();
      if (sprite) applySnippetFromUI(sprite, start, end);
    });
  }
  return snippetWave;
}
let snippetSpriteId = null;
let snippetFileUrl = null;
let snippetInputsLocked = false;

const fmtSec = (v) => `${(Number(v) || 0).toFixed(2)}s`;

/** The audio line the snippet editor currently targets for a sprite. */
function currentSnippetLine(sprite) {
  const custom = sprite?.audioEntry?.custom || [];
  if (!custom.length) return null;
  const snip = sprite.audioSnippet;
  if (snip && custom.some((l) => l.name === snip.name)) {
    return custom.find((l) => l.name === snip.name) ?? null;
  }
  return custom[0];
}

/** Persist a trimmed range as the sprite's snippet and sync the inputs. */
function applySnippetFromUI(sprite, start, end) {
  const line = currentSnippetLine(sprite);
  if (!line) return;
  scene.setAudioSnippet(sprite.id, {
    name: line.name,
    file: line.idb ? null : line.url,
    start,
    end,
  });
  snippetInputsLocked = true;
  snippetStartInput.value = fmtSec(start).slice(0, -1);
  snippetEndInput.value = fmtSec(end).slice(0, -1);
  snippetInputsLocked = false;
  snippetHint.textContent = `Snippet set: ${fmtSec(start)} → ${fmtSec(end)} (plays on press)`;
}

function setSnippetInputs(start, end) {
  snippetInputsLocked = true;
  snippetStartInput.value = (Number(start) || 0).toFixed(2);
  snippetEndInput.value = (Number(end) || 0).toFixed(2);
  snippetInputsLocked = false;
}

/** Rebuild the snippet section for the active sprite (waveform reload only
 *  when the sprite/file actually changed). */
async function refreshSnippetEditor() {
  const sprite = getActiveSprite();
  const custom = sprite?.audioEntry?.custom || [];
  const show = !!sprite && custom.length > 0;
  audioSnippetEl.classList.toggle("hidden", !show);
  if (!show) {
    snippetSpriteId = null;
    snippetFileUrl = null;
    snippetFileSel.innerHTML = "";
    snippetHint.textContent = "";
    snippetEditor().destroy();
    return;
  }

  const snip =
    sprite.audioSnippet && custom.some((l) => l.name === sprite.audioSnippet.name)
      ? sprite.audioSnippet
      : null;
  const chosenName = snip ? snip.name : custom[0].name;

  // Refresh the file <select> options for this sprite's audio files.
  snippetFileSel.innerHTML = "";
  for (const line of custom) {
    const opt = document.createElement("option");
    opt.value = line.name;
    opt.textContent = line.name;
    opt.selected = line.name === chosenName;
    snippetFileSel.appendChild(opt);
  }

  const line = custom.find((l) => l.name === chosenName) ?? custom[0];
  if (!line) return;

  if (snippetSpriteId === sprite.id && snippetFileUrl === line.url) {
    // Already showing this file — keep the region in sync with the model.
    if (!snip) setSnippetInputs(0, snippetEditor().duration ?? (snippetEndInput.value || 0));
    else setSnippetInputs(snip.start, snip.end ?? (snippetEditor().duration ?? snip.start));
    return;
  }

  snippetSpriteId = sprite.id;
  snippetFileUrl = line.url;
  snippetHint.textContent = "Loading waveform…";
  const sid = sprite.id;
  const ok = await snippetEditor().load(line.url, snip ? snip.start : 0, snip ? snip.end : null);
  // The active sprite may have changed while the audio was decoding.
  const still = getActiveSprite();
  if (!still || still.id !== sid) return;
  if (ok) {
    const dur = snippetEditor().duration;
    if (snip) setSnippetInputs(snip.start, snip.end != null ? snip.end : dur ?? snip.start);
    else setSnippetInputs(0, dur ?? 0);
    snippetHint.textContent = snip
      ? `Snippet: ${fmtSec(snip.start)} → ${fmtSec(snip.end ?? dur)}`
      : "Drag the region's edges to trim; the element plays the highlighted part when pressed.";
  } else {
    snippetHint.textContent = "Could not decode this audio file for trimming.";
  }
}

snippetFileSel.addEventListener("change", () => {
  const sprite = getActiveSprite();
  if (!sprite) return;
  // A snippet belongs to one audio file — switching files starts untrimmed.
  scene.setAudioSnippet(sprite.id, null);
  snippetSpriteId = null;
  snippetFileUrl = null;
  snippetHint.textContent = "";
  refreshSnippetEditor();
});

snippetClearBtn.addEventListener("click", () => {
  const sprite = getActiveSprite();
  if (!sprite) return;
  scene.setAudioSnippet(sprite.id, null);
  snippetSpriteId = null;
  snippetFileUrl = null;
  setSnippetInputs(0, snippetEditor().duration ?? 0);
  snippetHint.textContent = "No snippet — the element plays its audio normally.";
  refreshSnippetEditor();
});

snippetStartInput.addEventListener("input", () => {
  if (snippetInputsLocked) return;
  const sprite = getActiveSprite();
  const s = parseFloat(snippetStartInput.value);
  const e = parseFloat(snippetEndInput.value);
  if (!sprite || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
  applySnippetFromUI(sprite, s, e);
  snippetEditor().update(s, e);
});

snippetEndInput.addEventListener("input", () => {
  if (snippetInputsLocked) return;
  const sprite = getActiveSprite();
  const s = parseFloat(snippetStartInput.value);
  const e = parseFloat(snippetEndInput.value);
  if (!sprite || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
  applySnippetFromUI(sprite, s, e);
  snippetEditor().update(s, e);
});

snippetPreviewBtn.addEventListener("click", () => {
  const sprite = getActiveSprite();
  const line = currentSnippetLine(sprite);
  if (!sprite || !line) return;
  const s = parseFloat(snippetStartInput.value) || 0;
  const e = parseFloat(snippetEndInput.value);
  if (!Number.isFinite(e) || e <= s) {
    snippetHint.textContent = "Set a valid end after the start to preview.";
    return;
  }
  if (!sprite.audioSnippet) {
    scene.setAudioSnippet(sprite.id, {
      name: line.name,
      file: line.idb ? null : line.url,
      start: s,
      end: e,
    });
  }
  snippetEditor().update(s, e);
  snippetEditor().preview();
  snippetHint.textContent = `Previewing ${fmtSec(s)} → ${fmtSec(e)}`;
});

/** Attach an uploaded custom-audio line to a sprite and refresh the UI. */
function addCustomAudio(sprite, line) {
  let entry = sprite.audioEntry;
  if (!entry) {
    entry = { sourceId: sprite.characterId, categories: new Map(), custom: [] };
    sprite.audioEntry = entry;
  } else if (!Array.isArray(entry.custom)) {
    entry.custom = [];
  }
  if (!entry.custom.some((l) => l.name === line.name)) entry.custom.push(line);
  scene.audioCatalog.invalidate(sprite.characterId);
  rebuildAudioPanel();
  scene.persistStage();
  statusEl.textContent = `Audio added: ${line.name}`;
}

/** Remove a custom-audio line (deletes the server file or the IndexedDB
 *  upload, whichever backs it). */
async function removeCustomAudio(sprite, line) {
  const entry = sprite.audioEntry;
  if (!entry?.custom) return;
  if (line.idb) {
    try {
      await deleteAudioUpload(sprite.characterId, line.name);
    } catch (err) {
      console.warn("cannot delete audio upload:", err);
    }
    if (line.url) {
      try {
        URL.revokeObjectURL(line.url);
      } catch {}
    }
  } else {
    // A file next to the asset — ask the dev server to delete it.
    try {
      await fetch(`/api/audio?path=${encodeURIComponent(line.url)}`, { method: "DELETE" });
    } catch {}
  }
  entry.custom = entry.custom.filter((l) => l !== line);
  // A snippet referencing the deleted file is gone too.
  if (sprite.audioSnippet && sprite.audioSnippet.name === line.name) {
    sprite.audioSnippet = null;
  }
  scene.audioCatalog.invalidate(sprite.characterId);
  rebuildAudioPanel();
  scene.persistStage();
  statusEl.textContent = `Audio removed: ${line.name}`;
}

/** Compute the next free audio file name for IndexedDB fallback uploads. */
async function nextIdbAudioName(charId, base, ext) {
  const character = charactersById.get(charId);
  const existing = new Set();
  for (const url of character?.audio || []) existing.add(url.slice(url.lastIndexOf("/") + 1));
  try {
    for (const u of await listAudioUploads(charId)) existing.add(u.name);
  } catch {}
  const first = `${base}${ext}`;
  if (!existing.has(first)) return first;
  for (let n = 1; n < 1000; n++) {
    const name = `${base}_${String(n).padStart(2, "0")}${ext}`;
    if (!existing.has(name)) return name;
  }
  return `${base}_${Date.now()}${ext}`;
}

/** Upload a custom audio file for a sprite: the dev server's upload endpoint
 *  when available (writes the file next to the asset), IndexedDB otherwise. */
async function uploadCustomAudio(sprite, file) {
  const character = charactersById.get(sprite.characterId);
  if (!character || !character.audioBase || !character.audioDir) {
    statusEl.textContent = "This asset cannot take custom audio.";
    return;
  }
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  const AUDIO_EXTS = [".wav", ".mp3", ".ogg", ".m4a"];
  if (!AUDIO_EXTS.includes(ext)) {
    statusEl.textContent = `Unsupported audio format (${ext || "none"}).`;
    return;
  }
  const base = character.audioBase;
  try {
    const res = await fetch(
      `/api/audio?folder=${encodeURIComponent(character.audioDir)}&base=${encodeURIComponent(base)}&ext=${encodeURIComponent(ext)}`,
      { method: "POST", body: file }
    );
    if (res.ok) {
      const data = await res.json();
      addCustomAudio(sprite, { name: data.name, url: data.path, idb: false });
      return;
    }
  } catch {
    // No server — fall through to IndexedDB storage.
  }
  try {
    const name = await nextIdbAudioName(sprite.characterId, base, ext);
    await saveAudioUpload(sprite.characterId, name, file);
    addCustomAudio(sprite, { name, url: URL.createObjectURL(file), idb: true });
  } catch (err) {
    console.warn("cannot store audio upload:", err);
    statusEl.textContent = "Could not save the audio file.";
  }
}

/* ------------------------------------------------------------------ *
 * Header controls (bound to the active sprite)
 * ------------------------------------------------------------------ */

function syncControlsToActive() {
  const sprite = getActiveSprite();
  if (!sprite) {
    panelEmpty.classList.remove("hidden");
    panelContent.classList.add("hidden");
    characterLabel.textContent = "—";
    variantSelect.innerHTML = "";
    variantSelect.disabled = true;
    animationSelect.innerHTML = "";
    animationSelect.disabled = true;
    clickSelect.innerHTML = "";
    clickSelect.disabled = true;
    playPauseBtn.disabled = true;
    mirrorCheck.checked = false;
    mirrorCheck.disabled = true;
    layerSelect.innerHTML = "";
    layerSelect.disabled = true;
    statusEl.textContent = "";
    return;
  }
  panelEmpty.classList.add("hidden");
  panelContent.classList.remove("hidden");
  const character = charactersById.get(sprite.characterId);
  characterLabel.textContent = character?.name ?? "—";
  populateVariantSelectFor(sprite);
  if (sprite.model.animationNames.length) {
    onActiveAnimationsChanged(sprite, sprite.model.animationNames, sprite.model.currentAnimation);
  } else {
    animationSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.textContent = "(no animations)";
    opt.disabled = true;
    opt.selected = true;
    animationSelect.appendChild(opt);
    animationSelect.disabled = true;
    clickSelect.innerHTML = "";
    clickSelect.disabled = true;
  }
  speedSelect.value = String(sprite.model.speed);
  loopCheck.checked = sprite.model.loop;
  const scale = sprite.model.layoutConfig?.scale ?? 1;
  scaleRange.value = String(scale);
  scaleValue.textContent = `${scale.toFixed(2)}×`;
  opacityRange.value = String(Math.round(sprite.opacity * 100));
  opacityValue.textContent = `${Math.round(sprite.opacity * 100)}%`;
  tintColor.value = sprite.tint;
  const briPct = Math.round((sprite.brightness ?? 1) * 100);
  brightnessRange.value = String(briPct);
  brightnessValue.textContent = `${briPct}%`;
  const rgb = sprite.rgb || {};
  const setChannel = (range, valueEl, channel) => {
    const pct = Math.round((rgb[channel] ?? 1) * 100);
    range.value = String(pct);
    valueEl.textContent = `${pct}%`;
  };
  setChannel(colorRRange, colorRValue, "r");
  setChannel(colorGRange, colorGValue, "g");
  setChannel(colorBRange, colorBValue, "b");
  mirrorCheck.disabled = false;
  mirrorCheck.checked = !!sprite.model.mirror;
  populateLayerSelect();
  layerSelect.disabled = false;
  if (scene.layers.some((l) => l.id === sprite.layer)) layerSelect.value = sprite.layer;
  else layerSelect.value = scene.layers[0]?.id ?? "";
  audioVolumeRange.value = String(Math.round(scene.audioVolume * 100));
  rebuildAudioPanel();
  updatePlayPauseLabel();
  statusEl.textContent = sprite.statusText;
}

function populateVariantSelectFor(sprite) {
  const character = charactersById.get(sprite.characterId);
  variantSelect.innerHTML = "";
  // Custom image/video assets have no variants.
  const variants = character && character.variants ? Object.keys(character.variants) : [];
  if (!variants.length) {
    const opt = document.createElement("option");
    opt.textContent = "(no variants)";
    opt.disabled = true;
    opt.selected = true;
    variantSelect.appendChild(opt);
    variantSelect.disabled = true;
    return;
  }
  variantSelect.disabled = false;
  for (const name of variants) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === sprite.variant) opt.selected = true;
    variantSelect.appendChild(opt);
  }
}

function onActiveAnimationsChanged(sprite, names, selected, opts = {}) {
  animationSelect.innerHTML = "";
  if (!names.length) {
    const opt = document.createElement("option");
    opt.textContent = "(no animations)";
    opt.disabled = true;
    opt.selected = true;
    animationSelect.appendChild(opt);
    animationSelect.disabled = true;
    rebuildClickSelectFor(sprite, [], opts);
    updatePlayPauseLabel();
    return;
  }
  animationSelect.disabled = false;
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    animationSelect.appendChild(opt);
  }
  rebuildClickSelectFor(sprite, names, opts);
  updatePlayPauseLabel();
}

function rebuildClickSelectFor(sprite, names, opts = {}) {
  clickSelect.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "none";
  noneOpt.textContent = "none";
  clickSelect.appendChild(noneOpt);
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    clickSelect.appendChild(opt);
  }
  clickSelect.disabled = names.length === 0;

  // A fresh load applies the kind-specific default. Spine: variant-specific
  // (aim -> aim_fire, cover -> reload, normal -> action). Live2D: the model's
  // inferred reaction motion (e.g. a touch-named motion or TapBody group). On
  // a mere re-activation of the same sprite, keep the manual choice.
  const stored = sprite.clickAnimation;
  const fallback = () => {
    if (sprite.kind === "live2d") {
      const d = sprite.model.live2d?.defaultClickName;
      if (d && names.includes(d)) return d;
      const byStem = names.find((n) => /touch|tap|click|press|hit/i.test(n));
      return byStem ?? "none";
    }
    return defaultClickAnimation(sprite.variant, names);
  };
  const wanted = opts.forceDefault
    ? fallback()
    : stored === "none" || (stored && names.includes(stored))
      ? stored
      : fallback();
  clickSelect.value = wanted;
  sprite.clickAnimation = wanted;
}

function updatePlayPauseLabel() {
  const p = getActivePlayer();
  if (!p) {
    playPauseBtn.textContent = "Pause";
    playPauseBtn.disabled = true;
    return;
  }
  playPauseBtn.textContent = p.paused ? "Play" : "Pause";
  playPauseBtn.disabled = !p.playing && !p.currentAnimation;
}

function populateSpeedSelect() {
  speedSelect.innerHTML = "";
  for (const s of SPEEDS) {
    const opt = document.createElement("option");
    opt.value = String(s);
    opt.textContent = `${s}x`;
    if (s === 1) opt.selected = true;
    speedSelect.appendChild(opt);
  }
}

/* ------------------------------------------------------------------ *
 * Layers UI (per-sprite layer select + layer management panel)
 * ------------------------------------------------------------------ */

function populateLayerSelect() {
  layerSelect.innerHTML = "";
  for (const l of scene.layers) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    layerSelect.appendChild(opt);
  }
}

function rebuildLayersPanel() {
  layersList.innerHTML = "";
  scene.layers.forEach((layer, index) => {
    const row = document.createElement("div");
    row.className = "layer-item";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "layer-name";
    name.textContent = layer.name;
    name.title = "Rename layer";
    name.addEventListener("click", () => {
      const n = window.prompt("Layer name", layer.name);
      if (n != null && n.trim()) scene.renameLayer(layer.id, n.trim());
    });

    const up = document.createElement("button");
    up.type = "button";
    up.className = "layer-up";
    up.textContent = "↑";
    up.title = "Move layer down";
    up.disabled = index === 0;
    up.addEventListener("click", () => scene.reorderLayer(layer.id, index - 1));

    const down = document.createElement("button");
    down.type = "button";
    down.className = "layer-down";
    down.textContent = "↓";
    down.title = "Move layer up";
    down.disabled = index === scene.layers.length - 1;
    down.addEventListener("click", () => scene.reorderLayer(layer.id, index + 1));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "layer-delete";
    del.textContent = "✕";
    del.title = "Delete layer (its sprites move to the bottom layer)";
    del.addEventListener("click", () => scene.removeLayer(layer.id));

    row.appendChild(name);
    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(del);
    layersList.appendChild(row);
  });
}

/* ------------------------------------------------------------------ *
 * Character picker (multi-select: one tab per library folder, subtabs per
 * subfolder — built from the manifest tree)
 * ------------------------------------------------------------------ */

const THUMB_W = 256;
const THUMB_H = 320;
// Only render previews for this many items of a view per picker open — a
// folder can hold hundreds of skeletons, and rendering thumbnails for all of
// them up front would stall the picker. Items already on stage are always
// previewed (they stay within the 30-sprite cap).
const MAX_PREVIEWS_PER_VIEW = 60;
const gridCells = new Map(); // id -> { root, img, placeholder, tab, view }

const thumbnailer = new Thumbnailer(
  charactersById,
  (done, total) => {
    // Keep the change-mode hint ("Pick a character to replace …") visible.
    if (pickerMode === "change") return;
    pickerStatus.textContent = `Rendering previews… ${done}/${total}`;
    if (done >= total) pickerStatus.textContent = `${total} characters`;
  },
  (id, url) => setCellThumbnail(id, url)
);

/** Renders thumbnails for custom image/video assets (best-effort). */
class CustomAssetThumbnailer {
  constructor(onThumbnail) {
    this.onThumbnail = onThumbnail;
    this.cache = new Map(); // id -> dataURL | null
    this.queue = [];
    this.running = false;
    this.canvas = null;
  }

  get(id) {
    return this.cache.has(id) ? this.cache.get(id) : undefined;
  }

  enqueue(items) {
    for (const it of items) {
      const id = typeof it === "string" ? it : it.id;
      if (this.cache.has(id) || this.queue.includes(id)) continue;
      this.queue.push(id);
    }
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        const url = await this._renderOne(id);
        this.cache.set(id, url);
        if (this.onThumbnail) this.onThumbnail(id, url);
      }
    } finally {
      this.running = false;
    }
  }

  _ensureCanvas() {
    if (this.canvas) return this.canvas;
    this.canvas = document.createElement("canvas");
    this.canvas.width = THUMB_W;
    this.canvas.height = THUMB_H;
    this.canvas.style.position = "fixed";
    this.canvas.style.left = "-10000px";
    this.canvas.style.top = "0";
    document.body.appendChild(this.canvas);
    return this.canvas;
  }

  async _renderOne(id) {
    const c = charactersById.get(id);
    if (!c) return null;
    const canvas = this._ensureCanvas();
    const ctx = canvas.getContext("2d");
    try {
      const source = c.kind === "video" ? await this._videoFrame(c.url) : await this._image(c.url);
      if (!source) return null;
      const w = source.videoWidth || source.naturalWidth || 0;
      const h = source.videoHeight || source.naturalHeight || 0;
      if (!w || !h) return null;
      ctx.clearRect(0, 0, THUMB_W, THUMB_H);
      const scale = Math.min(THUMB_W / w, THUMB_H / h);
      const dw = w * scale;
      const dh = h * scale;
      ctx.drawImage(source, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh);
      return canvas.toDataURL("image/png");
    } catch (err) {
      console.warn(`[CustomThumbnailer] ${id}: ${err.message}`);
      return null;
    }
  }

  _image(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  _videoFrame(url) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.style.position = "fixed";
      v.style.left = "-9999px";
      v.style.width = "2px";
      v.style.height = "2px";
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        try {
          v.pause();
          v.remove();
        } catch {}
        resolve(val);
      };
      v.addEventListener("error", () => finish(null));
      v.addEventListener("loadeddata", () => {
        try {
          v.currentTime = 0.1;
        } catch {}
      });
      v.addEventListener("seeked", () => finish(v), { once: true });
      v.addEventListener("loadedmetadata", () => {
        if (v.videoWidth) setTimeout(() => finish(v), 400);
      });
      document.body.appendChild(v);
      v.src = url;
      v.load();
      v.play().catch(() => {});
      setTimeout(() => finish(null), 4000);
    });
  }
}

const customThumbnailer = new CustomAssetThumbnailer((id, url) => setCellThumbnail(id, url));

let activeTabIdx = 0; // index into PICKER_TABS (first tab is the default)
let activeViewIdx = 0; // index into the active tab's views (first view = default)
/** "add" = multi-select add/remove (the Add character button);
 *  "change" = pick ONE character to replace the active sprite's character. */
let pickerMode = "add";

function buildPickerGrid(container, chars, tab, viewKey) {
  for (const c of chars) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "picker-cell";
    cell.dataset.id = c.id;

    const thumb = document.createElement("div");
    thumb.className = "picker-thumb";
    const placeholder = document.createElement("div");
    placeholder.className = "thumb-placeholder";
    placeholder.textContent = "…";
    thumb.appendChild(placeholder);

    const check = document.createElement("span");
    check.className = "picker-check";
    check.textContent = "✓";
    thumb.appendChild(check);

    const name = document.createElement("div");
    name.className = "picker-name";
    name.textContent = c.name;

    const variants = document.createElement("div");
    variants.className = "picker-variants";
    if (c.kind === "image") variants.textContent = "image";
    else if (c.kind === "video") variants.textContent = "video";
    else if (c.kind === "gif") variants.textContent = "gif";
    else if (c.kind === "live2d") variants.textContent = c.live2dVersion === 2 ? "cubism 2" : "live2d";
    else {
      const n = Object.keys(c.variants || {}).length;
      variants.textContent = `${n} variant${n === 1 ? "" : "s"}`;
    }

    cell.appendChild(thumb);
    cell.appendChild(name);
    cell.appendChild(variants);

    cell.addEventListener("click", () => onPickerCellClick(c.id));
    container.appendChild(cell);

    gridCells.set(c.id, { root: cell, placeholder, img: null, tab, view: viewKey });
  }
}

/** Route a picker-cell click by the current mode. */
function onPickerCellClick(id) {
  if (pickerMode === "change") changeActiveSpriteCharacter(id);
  else toggleSprite(id);
}

/** Per-tab picker DOM: tab buttons and per-tab grid wrappers. */
const TAB_BUTTONS = new Map(); // tab.name -> tab button
const TAB_WRAPPERS = new Map(); // tab.name -> .picker-tab-grids wrapper

/** Build the picker DOM once: one tab button per library folder and one
 *  hidden subtab-block grid per view. All cells exist at boot so the search
 *  filter and thumbnail queues can reach every item without re-rendering. */
function buildPicker() {
  pickerTabs.innerHTML = "";
  pickerSubtabs.innerHTML = "";
  pickerGrids.innerHTML = "";
  gridCells.clear();
  TAB_BUTTONS.clear();
  TAB_WRAPPERS.clear();
  if (!PICKER_TABS.length) {
    const empty = document.createElement("div");
    empty.className = "picker-grid";
    empty.textContent = "No assets found — put supported files into folders of the content library.";
    pickerGrids.appendChild(empty);
    return;
  }
  for (const tab of PICKER_TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-tab";
    btn.dataset.tab = tab.name;
    btn.textContent = tab.label;
    btn.title = tab.name;
    btn.addEventListener("click", () => setActiveTabIndex(PICKER_TABS.indexOf(tab)));
    pickerTabs.appendChild(btn);
    TAB_BUTTONS.set(tab.name, btn);

    const wrap = document.createElement("div");
    wrap.className = "picker-tab-grids hidden";
    wrap.dataset.tab = tab.name;
    pickerGrids.appendChild(wrap);
    TAB_WRAPPERS.set(tab.name, wrap);

    for (const view of tab.views) {
      const grid = document.createElement("div");
      grid.className = "picker-grid hidden";
      grid.dataset.view = view.key == null ? "" : view.key;
      wrap.appendChild(grid);
      buildPickerGrid(grid, view.chars, tab.name, view.key == null ? "" : view.key);
    }
  }
  fitPickerStrips();
}

/** Show the active tab + subtab view; keep search/filter/thumbnails/status
 *  in sync with the current selection. */
function applyPickerView() {
  const tab = PICKER_TABS[activeTabIdx] ?? null;
  if (!tab) {
    pickerStatus.textContent = "No assets found.";
    return;
  }
  if (!tab.views[activeViewIdx]) activeViewIdx = 0;
  const view = tab.views[activeViewIdx];

  for (const [name, btn] of TAB_BUTTONS) btn.classList.toggle("active", name === tab.name);

  // Subtabs: shown whenever this tab's content is organised in subfolders
  // (i.e. it has at least one named subtab view); flat tabs have no row.
  pickerSubtabs.innerHTML = "";
  const showSubtabs = tab.views.some((v) => v.key != null);
  pickerSubtabs.classList.toggle("hidden", !showSubtabs);
  if (showSubtabs) {
    tab.views.forEach((v, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker-tab";
      btn.dataset.subtab = v.key == null ? "" : v.key;
      btn.textContent = viewButtonLabel(tab, v) ?? folderLabel(v.key);
      btn.classList.toggle("active", i === activeViewIdx);
      btn.addEventListener("click", () => {
        activeViewIdx = i;
        applyPickerView();
      });
      pickerSubtabs.appendChild(btn);
    });
  }

  const viewKey = view.key == null ? "" : view.key;
  for (const [name, wrap] of TAB_WRAPPERS) {
    const onTab = name === tab.name;
    wrap.classList.toggle("hidden", !onTab);
    for (const grid of wrap.children) {
      grid.classList.toggle("hidden", !(onTab && grid.dataset.view === viewKey));
    }
  }

  filterGrid(pickerSearch.value);
  refreshPickerCells();
  const chars = view.chars;
  const spineOnStage = [...scene.sprites.values()]
    .filter((s) => s.kind === "spine")
    .map((s) => s.characterId);
  // Prioritise the active view's previews so they render before the rest
  // (capped — see MAX_PREVIEWS_PER_VIEW).
  const previewTargets = chars
    .filter((c) => c.kind !== "image" && c.kind !== "video" && c.kind !== "gif" && c.kind !== "live2d" && !spineOnStage.includes(c.id))
    .map((c) => c.id)
    .slice(0, MAX_PREVIEWS_PER_VIEW);
  thumbnailer.enqueue([...spineOnStage, ...previewTargets], { priority: true });
  customThumbnailer.enqueue(
    chars.filter((c) => c.kind === "image" || c.kind === "video" || c.kind === "gif").slice(0, MAX_PREVIEWS_PER_VIEW)
  );
  if (pickerMode === "change") {
    const active = scene.getActiveSprite();
    const activeName = active ? (charactersById.get(active.characterId)?.name ?? active.characterId) : "the current element";
    pickerStatus.textContent = `Pick a character to replace ${activeName}`;
  } else {
    pickerStatus.textContent = `${chars.length} characters`;
  }
  fitPickerStrips();
}

/** Switch to a tab by its PICKER_TABS index, resetting to its first view. */
function setActiveTabIndex(idx) {
  if (idx < 0 || idx >= PICKER_TABS.length) return;
  activeTabIdx = idx;
  activeViewIdx = 0;
  applyPickerView();
}

/** Tabs/subtabs: the strips wrap onto up to two rows by default (CSS); when a
 *  strip would need more rows than fit, it is switched (.scroll) to ONE line
 *  that scrolls horizontally, so a huge number of folders never clips or eats
 *  the panel's height. Re-run whenever the strips change or the window
 *  resizes. */
function fitPickerStrips() {
  for (const el of [pickerTabs, pickerSubtabs]) {
    if (!el || el.clientHeight <= 0) continue; // hidden — measured when shown
    el.classList.toggle("scroll", el.scrollHeight > el.clientHeight + 1);
  }
}

/** Switch to a tab by its folder name. */
function setActiveTab(tabName) {
  const idx = PICKER_TABS.findIndex((t) => t.name === tabName);
  if (idx >= 0) setActiveTabIndex(idx);
}

function setCellThumbnail(id, url) {
  const cell = gridCells.get(id);
  if (!cell) return;
  if (url == null) {
    cell.placeholder.classList.add("failed");
    cell.placeholder.textContent = "";
    return;
  }
  const img = document.createElement("img");
  img.src = url;
  img.alt = id;
  img.loading = "lazy";
  img.addEventListener("load", () => cell.placeholder.remove());
  cell.img = img;
  cell.root.querySelector(".picker-thumb").appendChild(img);
}

function openPicker(mode = "add") {
  pickerMode = mode === "change" ? "change" : "add";
  picker.classList.toggle("change-mode", pickerMode === "change");
  picker.classList.remove("hidden");
  pickerSearch.value = "";
  pickerFolderRow.classList.add("hidden"); // fresh open: collapsed folder row
  // Re-apply the current tab/view (falling back to the first if the library
  // changed between opens).
  if (activeTabIdx >= PICKER_TABS.length) activeTabIdx = 0;
  if (!PICKER_TABS[activeTabIdx]?.views[activeViewIdx]) activeViewIdx = 0;
  applyPickerView();
  pickerSearch.focus();
}

function closePicker() {
  pickerMode = "add";
  picker.classList.remove("change-mode");
  picker.classList.add("hidden");
}

/* ------------------------------------------------------------------ *
 * Content-folder control (runtime switch of the library root)
 *
 * GET/POST /api/content reports/switches the server's content root. The last
 * folder chosen here is remembered in localStorage and re-applied on boot
 * (applyPersistedContentRoot, above the manifest fetch) so a chosen library
 * survives restarts. Switching changes the whole library: the page reloads
 * and any on-stage characters that no longer exist are dropped.
 * ------------------------------------------------------------------ */

/** Load the current + default content dirs into the folder row's input. */
async function refreshFolderRow() {
  pickerFolderStatus.textContent = "";
  try {
    const res = await fetch("api/content", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    pickerFolderInput.value = data.dir || "";
    pickerFolderInput.title = `Default: ${data.defaultDir || ""}`;
  } catch (err) {
    pickerFolderStatus.textContent = `Cannot read the content folder (${err.message}).`;
  }
}

function setFolderBusy(busy) {
  pickerFolderApply.disabled = busy;
  pickerFolderReset.disabled = busy;
}

/** Apply the typed folder: switch the server root, remember it, reload. */
async function applyContentFolder() {
  const dir = pickerFolderInput.value.trim();
  if (pickerFolderApply.disabled) return;
  if (!dir) {
    pickerFolderStatus.textContent = "Enter the folder path (or press Default).";
    return;
  }
  setFolderBusy(true);
  pickerFolderStatus.textContent = "";
  try {
    const previous = await currentContentDir();
    // Ask the server first: an invalid folder yields an error with no reload.
    const res = await fetch("api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      pickerFolderStatus.textContent = `Cannot use that folder: ${(data && data.error) || `HTTP ${res.status}`}`;
      return;
    }
    if (!previous || data.dir === previous) {
      pickerFolderStatus.textContent = `Already using ${data.dir}`;
      return;
    }
    if (
      !window.confirm(`Switch the content library to:\n\n${data.dir}\n\nThe editor reloads and any characters not present in this folder are removed from the stage.`)
    ) {
      // Revert the switch we just made so the app keeps showing the old library.
      try {
        await fetch("api/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: previous }),
        });
      } catch {}
      return;
    }
    try {
      localStorage.setItem(CONTENT_FOLDER_KEY, data.dir);
    } catch {}
    location.reload();
  } catch (err) {
    pickerFolderStatus.textContent = `Failed: ${err.message}`;
  } finally {
    setFolderBusy(false);
  }
}

async function currentContentDir() {
  try {
    const res = await fetch("api/content", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      return data.dir || "";
    }
  } catch {}
  return "";
}

/** Back to the default content folder (env/launch default); reload. */
async function resetContentFolder() {
  if (pickerFolderReset.disabled) return;
  setFolderBusy(true);
  pickerFolderStatus.textContent = "";
  try {
    const previous = await currentContentDir();
    const res = await fetch("api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: "" }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      pickerFolderStatus.textContent = `Reset failed: ${(data && data.error) || `HTTP ${res.status}`}`;
      return;
    }
    if (!previous || data.dir === previous) {
      pickerFolderStatus.textContent = `Already using the default folder (${data.dir})`;
      return;
    }
    if (
      !window.confirm(`Reset the content library to the default folder:\n\n${data.dir}\n\nThe editor reloads and any characters not present in this folder are removed from the stage.`)
    ) {
      // Revert the reset so the app keeps showing the current library.
      try {
        await fetch("api/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: previous }),
        });
      } catch {}
      return;
    }
    try {
      localStorage.removeItem(CONTENT_FOLDER_KEY);
    } catch {}
    location.reload();
  } catch (err) {
    pickerFolderStatus.textContent = `Reset failed: ${err.message}`;
  } finally {
    setFolderBusy(false);
  }
}

/** On boot: point the server at the remembered content folder (if any) so the
 *  manifest/picker describe the library the user last chose. A no-op when
 *  nothing was remembered or when there is no /api/content (static hosting). */
async function applyPersistedContentRoot() {
  let stored = null;
  try {
    stored = localStorage.getItem(CONTENT_FOLDER_KEY);
  } catch {}
  if (!stored) return;
  try {
    const res = await fetch("api/content", { cache: "no-store" });
    if (!res.ok) return; // static deployment — leave localStorage alone
    const cur = await res.json();
    if (cur && cur.dir === stored) return; // already applied
    const apply = await fetch("api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: stored }),
    });
    const data = await apply.json().catch(() => null);
    if (!apply.ok || !data || !data.ok) {
      // The remembered folder is gone — drop it and keep the server default.
      try {
        localStorage.removeItem(CONTENT_FOLDER_KEY);
      } catch {}
    }
  } catch {
    // No server reachable — keep the remembered choice for the next run.
  }
}

/** Change the ACTIVE sprite's character to the picked one. The sprite's
 *  layout and visuals (position, size, colour/opacity, mirror, layer) are
 *  kept; variant/animation/click/audio reset to the new character's
 *  defaults. Changing to a character already on stage is blocked (one
 *  instance per character). */
function changeActiveSpriteCharacter(newId) {
  const sprite = scene.getActiveSprite();
  if (!sprite) return;
  if (newId === sprite.characterId) {
    closePicker();
    return;
  }
  const character = charactersById.get(newId);
  if (!character) return;
  if (isUnsupportedLive2d(character)) {
    statusEl.textContent = `${character.name}: Live2D Cubism 2 format is not supported (Cubism 3/4/5 .model3.json models only).`;
    return; // stay in change mode so another pick is possible
  }
  if ([...scene.sprites.values()].some((s) => s.id !== sprite.id && s.characterId === newId)) {
    statusEl.textContent = `${character.name} is already on the stage.`;
    return; // stay in change mode so another pick is possible
  }
  // Revoke object URLs of the old character's custom audio, if any.
  for (const line of sprite.audioEntry?.custom || []) {
    if (line.idb && line.url) {
      try {
        URL.revokeObjectURL(line.url);
      } catch {}
    }
  }
  sprite.characterId = newId;
  sprite.variant = defaultVariant(character);
  sprite.clickAnimation = null;
  sprite.audioCategories = new Set();
  sprite.savedAudioCategories = null;
  sprite.audio = null;
  // Non-empty settings re-apply the kept colour/opacity once the new
  // skeleton has loaded (a fresh skeleton resets its colour to white).
  sprite.settings = {};
  scene.loadSprite(sprite);
  scene.loadSpriteAudio(sprite);
  scene.persistStage();
  refreshPickerCells();
  closePicker();
  statusEl.textContent = `Element changed to ${character.name}`;
}

/** Show which characters are already on stage (✓ badge); in change mode,
 *  highlight the active sprite's current character instead. */
function refreshPickerCells() {
  const onStage = new Set([...scene.sprites.values()].map((s) => s.characterId));
  const activeChar = pickerMode === "change" ? scene.getActiveSprite()?.characterId : null;
  for (const [id, cell] of gridCells) {
    cell.root.classList.toggle("on-stage", pickerMode !== "change" && onStage.has(id));
    cell.root.classList.toggle("current-char", pickerMode === "change" && id === activeChar);
  }
}

function filterGrid(query) {
  const q = query.trim().toLowerCase();
  const tab = PICKER_TABS[activeTabIdx] ?? null;
  const view = tab ? tab.views[activeViewIdx] ?? null : null;
  const tabKey = tab ? tab.name : null;
  const viewKey = view ? (view.key == null ? "" : view.key) : null;
  for (const [id, cell] of gridCells) {
    // Only the active tab (+ subtab) is visible; within it, filter.
    const inView = cell.tab === tabKey && cell.view === viewKey;
    const matches = !q || id.includes(q);
    cell.root.style.display = inView && matches ? "" : "none";
  }
}

/** Add/remove a character (or custom asset) from the stage (max 30). */
function toggleSprite(id) {
  const character = charactersById.get(id);
  if (isUnsupportedLive2d(character)) {
    statusEl.textContent = `${character.name}: Live2D Cubism 2 format is not supported (Cubism 3/4/5 .model3.json models only).`;
    return;
  }
  const existing = [...scene.sprites.values()].find((s) => s.characterId === id);
  if (existing) {
    scene.removeSprite(existing.id);
    return;
  }
  if (scene.sprites.size >= MAX_SPRITES) {
    statusEl.textContent = `Maximum ${MAX_SPRITES} sprites`;
    return;
  }
  scene.addSprite(id);
}

/** Legacy (Cubism 2) Live2D entries: listed for visibility but never added —
 *  the licensed runtime can only render Cubism 3/4/5 (.model3.json). */
function isUnsupportedLive2d(character) {
  return !!character && character.kind === "live2d" && character.live2dVersion === 2;
}

/** Ensure a character is on the stage and make it active (legacy/debug API). */
function selectCharacter(id) {
  const character = charactersById.get(id);
  if (!character) return null;
  if (isUnsupportedLive2d(character)) {
    statusEl.textContent = `${character.name}: Live2D Cubism 2 format is not supported (Cubism 3/4/5 .model3.json models only).`;
    return null;
  }
  let sprite = [...scene.sprites.values()].find((s) => s.characterId === id);
  if (!sprite) {
    if (scene.sprites.size >= MAX_SPRITES) {
      statusEl.textContent = `Maximum ${MAX_SPRITES} sprites`;
      return null;
    }
    sprite = scene.addSprite(id);
  }
  if (sprite) scene.activateSprite(sprite.id);
  closePicker();
  return sprite ? sprite.id : null;
}

/* ------------------------------------------------------------------ *
 * Scenes (named, locally saved scene configurations — replaces presets)
 *
 * Each scene stores a full state snapshot (sprites, layers, audio volume and
 * background mode/colour) in localStorage under "spineViewer.scenes"; the
 * background image/video blob lives in IndexedDB keyed by the scene id. The
 * current scene is auto-saved on every change via scene.onPersist.
 * ------------------------------------------------------------------ */

const SCENES_KEY = "spineViewer.scenes";

function readScenes() {
  try {
    const raw = localStorage.getItem(SCENES_KEY);
    const data = raw ? JSON.parse(raw) : null;
    if (data && Array.isArray(data.list)) return data;
  } catch (err) {
    console.warn("cannot read scenes:", err);
  }
  return null;
}

function writeScenes(data) {
  try {
    // currentSceneId is the single source of truth; scenesData.current is
    // derived at write time so it can never go stale.
    localStorage.setItem(SCENES_KEY, JSON.stringify({ current: currentSceneId, list: data.list }));
  } catch (err) {
    console.warn("cannot save scenes:", err);
  }
}

let scenesData = null; // { current: sceneId, list: [{ id, name, state }] }
let currentSceneId = null;

function getCurrentSceneRec() {
  return scenesData ? scenesData.list.find((s) => s.id === currentSceneId) : null;
}

function emptySceneState() {
  return {
    active: null,
    layers: [{ id: "layer-1", name: "Layer 1" }],
    sprites: [],
    zOrder: [],
    audioVolume: 1,
    bg: { mode: "transparent", color: "#000000" },
  };
}

/** Copy the current controller state into the current scene record. */
function saveCurrentSceneState() {
  if (!scenesData) return;
  const rec = getCurrentSceneRec();
  if (!rec) return;
  rec.state = {
    ...scene.captureStage(),
    bg: { mode: scene.bgMode, color: scene.bgColor },
  };
  writeScenes(scenesData);
}

/** Replace the controller with a scene's saved state and refresh the UI. */
async function loadSceneStateInto(state, sceneId) {
  scene.bgDbKey = sceneId;
  await scene.applyState(state, { bgBlobKey: sceneId });
  audioVolumeRange.value = String(Math.round(scene.audioVolume * 100));
  populateLayerSelect();
  rebuildLayersPanel();
  syncControlsToActive();
}

/** Switch to another scene (saving the current one first). */
async function switchScene(sceneId) {
  const rec = scenesData.list.find((s) => s.id === sceneId);
  if (!rec) return false;
  if (sceneId === currentSceneId) return true;
  currentSceneId = sceneId;
  writeScenes(scenesData);
  await loadSceneStateInto(rec.state, sceneId);
  rebuildScenesPanel();
  statusEl.textContent = `Scene: ${rec.name}`;
  return true;
}

/** Create a new EMPTY scene (zero sprites, default layer, transparent
 *  background) and switch to it immediately, clearing the stage. */
async function createNewScene(name = null) {
  const id = `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const label = String(name || "").trim() || `Scene ${scenesData.list.length + 1}`;
  const state = emptySceneState();
  scenesData.list.push({ id, name: label, state });
  writeScenes(scenesData);
  await switchScene(id);
  // Guarantee the new scene is stored as EMPTY (sprites cleared, default
  // layer, transparent background) even if an auto-save raced the switch.
  const rec = getCurrentSceneRec();
  if (rec) {
    rec.state = { ...scene.captureStage(), bg: { mode: scene.bgMode, color: scene.bgColor } };
    writeScenes(scenesData);
  }
  rebuildScenesPanel();
  statusEl.textContent = `New empty scene: ${label}`;
  return id;
}

function renameScene(id, name) {
  const rec = scenesData.list.find((s) => s.id === id);
  if (!rec) return;
  name = String(name || "").trim();
  if (!name) return;
  rec.name = name;
  writeScenes(scenesData);
  rebuildScenesPanel();
}

async function deleteScene(id) {
  if (scenesData.list.length <= 1) {
    statusEl.textContent = "Cannot delete the last scene";
    return;
  }
  scenesData.list = scenesData.list.filter((s) => s.id !== id);
  try {
    await scene.deleteBgImage(id);
  } catch (err) {
    console.warn("cannot delete scene image:", err);
  }
  if (currentSceneId === id) {
    currentSceneId = scenesData.list[0].id;
    writeScenes(scenesData);
    await loadSceneStateInto(scenesData.list[0].state, currentSceneId);
  } else {
    writeScenes(scenesData);
  }
  rebuildScenesPanel();
}

function rebuildScenesPanel() {
  scenesList.innerHTML = "";
  for (const rec of scenesData.list) {
    const row = document.createElement("div");
    row.className = "scene-item" + (rec.id === currentSceneId ? " active" : "");

    const load = document.createElement("button");
    load.type = "button";
    load.className = "scene-load";
    load.textContent = rec.id === currentSceneId ? `${rec.name} (current)` : rec.name;
    load.title = "Switch to this scene";
    load.addEventListener("click", () => {
      switchScene(rec.id);
      scenesPanel.classList.add("hidden");
    });

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "scene-rename";
    rename.textContent = "✎";
    rename.title = "Rename scene";
    rename.addEventListener("click", () => {
      const n = window.prompt("Scene name", rec.name);
      if (n != null && n.trim()) renameScene(rec.id, n.trim());
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "scene-delete";
    del.textContent = "✕";
    del.title = "Delete scene";
    del.addEventListener("click", () => {
      if (window.confirm(`Delete scene "${rec.name}"?`)) deleteScene(rec.id);
    });

    row.appendChild(load);
    row.appendChild(rename);
    row.appendChild(del);
    scenesList.appendChild(row);
  }
}

/** Boot the scene manager: seed the first scene (migrating the legacy saved
 *  stage + background), then load the current scene. */
async function initScenes() {
  let stored = readScenes();
  if (!stored || !stored.list.length) {
    let legacyStage = null;
    let legacyBg = null;
    try {
      legacyStage = JSON.parse(localStorage.getItem("spineViewer.stage") || "null");
    } catch {}
    try {
      legacyBg = JSON.parse(localStorage.getItem("spineViewer.bg") || "null");
    } catch {}
    const id = `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const hasLegacy = legacyStage && Array.isArray(legacyStage.sprites) && legacyStage.sprites.length;
    const bg = { mode: legacyBg?.mode || "transparent", color: legacyBg?.color || "#000000" };
    const state = hasLegacy
      ? { ...legacyStage, bg }
      : {
          active: CHARACTERS.length ? CHARACTERS[0].id : null,
          layers: [{ id: "layer-1", name: "Layer 1" }],
          sprites: CHARACTERS.length
            ? [{ characterId: CHARACTERS[0].id, variant: "normal", loop: true, speed: 1 }]
            : [],
          zOrder: CHARACTERS.length ? [CHARACTERS[0].id] : [],
          audioVolume: 1,
          bg,
        };
    scenesData = { current: id, list: [{ id, name: "Scene 1", state }] };
    currentSceneId = id;
    writeScenes(scenesData);
    // Migrate the legacy background blob (stored under the "current" key)
    // into the bg DB under the new scene id.
    try {
      const legacyBlob = await scene.loadBgImageBlob("current");
      if (legacyBlob) await scene.saveBgImage(legacyBlob, id);
    } catch (err) {
      console.warn("cannot migrate background blob:", err);
    }
  } else {
    scenesData = stored;
    currentSceneId =
      stored.current && stored.list.some((s) => s.id === stored.current)
        ? stored.current
        : stored.list[0].id;
  }

  scene.onPersist = () => saveCurrentSceneState();

  const rec = scenesData.list.find((s) => s.id === currentSceneId) ?? scenesData.list[0];
  currentSceneId = rec.id;
  await loadSceneStateInto(rec.state, rec.id);
  rebuildScenesPanel();
}

/* ------------------------------------------------------------------ *
 * Aspect-ratio guides overlay
 * ------------------------------------------------------------------ */

const GUIDES_KEY = "spineViewer.guides";

function restoreGuides() {
  try {
    const v = localStorage.getItem(GUIDES_KEY);
    if (v && [...guidesSelect.options].some((o) => o.value === v)) guidesSelect.value = v;
  } catch {}
  applyGuides();
}

function applyGuides() {
  try {
    localStorage.setItem(GUIDES_KEY, guidesSelect.value);
  } catch {}
  updateGuidesOverlay();
}

function updateGuidesOverlay() {
  const [rw, rh] = (guidesSelect.value || "off").split("/").map(Number);
  if (!rw || !rh) {
    guidesOverlay.classList.add("hidden");
    return;
  }
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  const gw = Math.min(w, (h * rw) / rh);
  const gh = (gw * rh) / rw;
  guidesOverlay.style.width = `${gw}px`;
  guidesOverlay.style.height = `${gh}px`;
  guidesOverlay.classList.remove("hidden");
}

function cycleGuides() {
  const options = [...guidesSelect.options].map((o) => o.value);
  const idx = options.indexOf(guidesSelect.value);
  guidesSelect.value = options[(idx + 1) % options.length];
  applyGuides();
}

/* ------------------------------------------------------------------ *
 * Export (POST /api/export + open-folder step)
 * ------------------------------------------------------------------ */

let lastExportName = null;

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("cannot read blob"));
    r.readAsDataURL(blob);
  });

/** Extension + video flag for a background blob (used by the export). */
function bgBlobInfo(blob) {
  const type = String(blob?.type || "").toLowerCase();
  if (type.startsWith("video/")) {
    return { video: true, ext: type.includes("mp4") ? "mp4" : "webm" };
  }
  if (type.includes("jpeg")) return { video: false, ext: "jpg" };
  if (type.includes("webp")) return { video: false, ext: "webp" };
  if (type.includes("gif")) return { video: false, ext: "gif" };
  return { video: false, ext: "png" };
}

/** Export the current scene via the dev server into the combined
 *  Wallpaper-Engine/Octos folder package (+ .zip; Lively writes its own
 *  LivelyInfo.json on import), then offer/perform
 *  the open-folder step. */
async function exportCurrentScene() {
  const rec = getCurrentSceneRec();
  if (!rec) {
    statusEl.textContent = "Export failed: no scene to export.";
    return;
  }
  exportBtn.disabled = true;
  statusEl.textContent = "Exporting…";
  try {
    const payload = { name: rec.name, scene: rec.state };
    // Image/video background: the server cannot see the editor's blob, so the
    // bytes travel with the request (base64).
    if (scene.bgMode === "image" && scene.bgImageBlob) {
      const { ext, video } = bgBlobInfo(scene.bgImageBlob);
      const dataUrl = await blobToBase64(scene.bgImageBlob);
      payload.bgFile = { ext, video, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
    }
    const res = await fetch("api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    lastExportName = data.name;
    openFolderBtn.disabled = false;
    const mb = ((data.bytes || 0) / (1024 * 1024)).toFixed(1);
    const zipNote = data.zip ? " (+ .zip for Octos)" : "";
    statusEl.textContent = `Exported "${rec.name}" (${data.sprites} sprite(s), ${data.files} files, ${mb} MB) → ${data.displayPath}${zipNote}`;
    // Open-folder step: show the result in the OS file manager (best effort).
    openExportedFolder(data.name);
  } catch (err) {
    statusEl.textContent = `Export failed: ${err.message}`;
  } finally {
    exportBtn.disabled = false;
  }
}

/** Ask the dev server to reveal an exported package in the file manager. */
async function openExportedFolder(name) {
  if (!name) return;
  try {
    await fetch("api/export/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (err) {
    console.warn("open folder failed:", err);
  }
}

/* ------------------------------------------------------------------ *
 * Fullscreen preview (view the wallpaper without the editor UI)
 * ------------------------------------------------------------------ */

function setPreview(on) {
  if (on) {
    // Preview is a viewing mode: dragging/removing sprites via the edit
    // overlays must not be possible in it, so leave edit mode on the way in
    // (also clears any in-progress drag/resize and the overlays).
    if (editMode) setEditMode(false);
  }
  document.body.classList.toggle("preview", !!on);
  previewBtn.textContent = on ? "Exit preview" : "Preview";
  previewBtn.classList.toggle("active", !!on);
  previewHint.classList.toggle("hidden", !on);
  if (on) {
    picker.classList.add("hidden");
    layersPanel.classList.add("hidden");
    scenesPanel.classList.add("hidden");
  } else {
    updateEditOverlays();
  }
}

/* ------------------------------------------------------------------ *
 * Settings panel collapse (persisted)
 * ------------------------------------------------------------------ */

const PANEL_KEY = "spineViewer.panelCollapsed";

function setPanelCollapsed(collapsed) {
  document.body.classList.toggle("panel-collapsed", !!collapsed);
  try {
    localStorage.setItem(PANEL_KEY, collapsed ? "1" : "0");
  } catch {}
  requestAnimationFrame(() => {
    scene.stageRenderer.resize();
    updateGuidesOverlay();
    updateEditOverlays();
  });
}

function restorePanelState() {
  try {
    if (localStorage.getItem(PANEL_KEY) === "1") setPanelCollapsed(true);
  } catch {}
}

/* ------------------------------------------------------------------ *
 * Edit mode (drag / resize / remove overlays)
 * ------------------------------------------------------------------ */

let editMode = false;
let dragState = null; // { sprite, sx, sy, startX, startY }
let resizeState = null; // { sprite, startDist, startFw, startFh }

function canvasSize() {
  return {
    w: stageCanvas.clientWidth || 1,
    h: stageCanvas.clientHeight || 1,
  };
}

/** Freeze a sprite's current position + size as canvas fractions. */
function pinSprite(sprite) {
  const { w, h } = canvasSize();
  const r = sprite.model.modelRect(w, h);
  if (!r) return;
  const cfg = sprite.model.layoutConfig;
  // cfg.x is the CAMERA centre fraction. A mirrored sprite renders at
  // (canvas − camera centre), so the stored fraction is the reflection.
  const cx = (r.left + r.right) / (2 * w);
  cfg.x = sprite.model.mirror ? 1 - cx : cx;
  cfg.y = (r.top + r.bottom) / (2 * h);
  cfg.fw = (r.right - r.left) / w;
  cfg.fh = (r.bottom - r.top) / h;
  cfg.scale = 1; // size is now captured by fw/fh
}

function ensureEditOverlay(sprite) {
  if (sprite.overlay) return sprite.overlay;
  const ov = document.createElement("div");
  ov.className = "edit-overlay";
  ov.dataset.spriteId = sprite.id;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "edit-remove";
  remove.title = "Remove sprite";
  remove.textContent = "×";
  remove.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  remove.addEventListener("click", (ev) => {
    ev.stopPropagation();
    scene.removeSprite(sprite.id);
  });

  const handle = document.createElement("div");
  handle.className = "edit-resize";
  handle.title = "Drag to resize";
  handle.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    const { w, h } = canvasSize();
    const r = sprite.model.modelRect(w, h);
    if (!r) return;
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy) || 1;
    pinSprite(sprite); // freeze position + size before resizing
    const cfg = sprite.model.layoutConfig;
    resizeState = { sprite, startDist: dist, startFw: cfg.fw, startFh: cfg.fh };
  });

  ov.appendChild(remove);
  ov.appendChild(handle);
  stage.appendChild(ov);
  sprite.overlay = ov;
  return ov;
}

function updateEditOverlays() {
  if (!editMode) return;
  const { w, h } = canvasSize();
  for (const sprite of scene.sprites.values()) {
    const r = sprite.model.modelRect(w, h);
    const ov = ensureEditOverlay(sprite);
    if (!r) {
      ov.style.display = "none";
      continue;
    }
    ov.style.display = "block";
    ov.style.left = `${r.left}px`;
    ov.style.top = `${r.top}px`;
    ov.style.width = `${r.right - r.left}px`;
    ov.style.height = `${r.bottom - r.top}px`;
  }
}

function clearEditOverlays() {
  for (const sprite of scene.sprites.values()) {
    if (sprite.overlay) {
      sprite.overlay.remove();
      sprite.overlay = null;
    }
  }
}

function setEditMode(on) {
  editMode = on;
  editToggleBtn.textContent = on ? "Done" : "Edit";
  editToggleBtn.classList.toggle("active", on);
  if (on) {
    updateEditOverlays();
  } else {
    dragState = null;
    resizeState = null;
    clearEditOverlays();
  }
}

/** Scale the active sprite around its centre (pin + scale fw/fh). */
function scaleActiveSprite(factor) {
  const sprite = getActiveSprite();
  if (!sprite) return;
  pinSprite(sprite);
  const cfg = sprite.model.layoutConfig;
  cfg.fw = Math.min(5, Math.max(0.05, (cfg.fw ?? 0.2) * factor));
  cfg.fh = Math.min(5, Math.max(0.05, (cfg.fh ?? 0.2) * factor));
  scene.stageRenderer.resize();
  updateEditOverlays();
  scene.persistStage();
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function wireEvents() {
  // "Add character" opens the picker in multi-select add/remove mode; the
  // panel's Character control opens it in single-select "change" mode.
  addCharBtn.addEventListener("click", () => openPicker("add"));
  characterBtn.addEventListener("click", () => openPicker("change"));
  pickerClose.addEventListener("click", closePicker);
  // Tab/subtab buttons are created and wired by buildPicker()/applyPickerView().
  picker.addEventListener("click", (ev) => {
    if (ev.target === picker) closePicker();
  });
  pickerSearch.addEventListener("input", () => filterGrid(pickerSearch.value));

  // Content-folder control: toggle the folder row, apply/reset the root.
  pickerFolderBtn.addEventListener("click", async () => {
    const show = pickerFolderRow.classList.contains("hidden");
    pickerFolderRow.classList.toggle("hidden", !show);
    if (show) {
      await refreshFolderRow();
      pickerFolderInput.focus();
    }
  });
  pickerFolderApply.addEventListener("click", applyContentFolder);
  pickerFolderReset.addEventListener("click", resetContentFolder);
  pickerFolderInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      applyContentFolder();
    }
  });
  // Scroll the tab/subtab strips horizontally with the wheel when they are in
  // their horizontal-scroll mode (nothing to translate -> default behaviour).
  for (const strip of [pickerTabs, pickerSubtabs]) {
    strip.addEventListener(
      "wheel",
      (ev) => {
        if (ev.deltaY && strip.scrollWidth > strip.clientWidth) {
          strip.scrollLeft += ev.deltaY;
          ev.preventDefault();
        }
      },
      { passive: false }
    );
  }
  // Listen on window (not document) so synthetic keydown dispatches on
  // window also reach the handler (real input bubbles to both).
  window.addEventListener("keydown", onKeyDown);

  editToggleBtn.addEventListener("click", () => setEditMode(!editMode));

  // Clicking a sprite selects it; holding on the sprite plays its click
  // animation. In edit mode, clicking/dragging moves the sprite instead.
  // The stage is one shared canvas, so find the sprite whose model bounds
  // contain the point (topmost wins).
  stageCanvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return; // left button / primary touch only
    const rect = stageCanvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const sprite = scene.spriteAtPoint(x, y);
    if (!sprite) return;
    scene.activateSprite(sprite.id);

    if (editMode) {
      // Drag the sprite. Pin it first so it keeps its size (and gains an
      // explicit position) rather than shrinking when sprites are added.
      pinSprite(sprite);
      const cfg = sprite.model.layoutConfig;
      dragState = { sprite, sx: ev.clientX, sy: ev.clientY, startX: cfg.x, startY: cfg.y };
      return;
    }

    scene.pressSprite(sprite);
  });

  window.addEventListener("pointermove", (ev) => {
    if (dragState) {
      // The first actual move lifts the sprite to the top of the draw order.
      if (!dragState.front) {
        dragState.front = true;
        scene.stageRenderer.bringToFront(dragState.sprite.model);
      }
      const { w, h } = canvasSize();
      // A mirrored sprite renders at (canvas - camera centre), so its camera
      // must move opposite the mouse for the sprite to follow the pointer.
      const dirX = dragState.sprite.model.mirror ? -1 : 1;
      const dx = ((ev.clientX - dragState.sx) / w) * dirX;
      const dy = (ev.clientY - dragState.sy) / h;
      dragState.sprite.model.layoutConfig.x = dragState.startX + dx;
      dragState.sprite.model.layoutConfig.y = dragState.startY + dy;
      scene.stageRenderer.resize();
      updateEditOverlays();
    } else if (resizeState) {
      const { w, h } = canvasSize();
      const r = resizeState.sprite.model.modelRect(w, h);
      if (r) {
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy) || 1;
        const ratio = Math.min(5, Math.max(0.1, dist / resizeState.startDist));
        resizeState.sprite.model.layoutConfig.fw = resizeState.startFw * ratio;
        resizeState.sprite.model.layoutConfig.fh = resizeState.startFh * ratio;
        scene.stageRenderer.resize();
        updateEditOverlays();
      }
    }
  });

  const endDrag = () => {
    if (dragState || resizeState) {
      dragState = null;
      resizeState = null;
      scene.persistStage();
      // Pinning a sprite captures its size (scale resets to 1) — refresh the
      // panel's scale slider and the overlays.
      syncControlsToActive();
      updateEditOverlays();
    }
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointerup", () => scene.releaseSprite());
  window.addEventListener("pointercancel", () => scene.releaseSprite());
  window.addEventListener("blur", () => scene.releaseSprite());

  variantSelect.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.variant = variantSelect.value;
    scene.loadSprite(sprite);
    scene.persistStage();
  });

  animationSelect.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.model.setAnimation(animationSelect.value, loopCheck.checked);
    updatePlayPauseLabel();
    scene.persistStage();
  });

  clickSelect.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (sprite) {
      sprite.clickAnimation = clickSelect.value;
      scene.persistStage();
    }
  });

  playPauseBtn.addEventListener("click", () => {
    const sprite = getActiveSprite();
    if (!sprite || !sprite.model.currentAnimation) return;
    sprite.model.togglePause();
    updatePlayPauseLabel();
    scene.persistStage();
  });

  restartBtn.addEventListener("click", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.model.restart();
    updatePlayPauseLabel();
  });

  loopCheck.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (sprite) {
      sprite.model.setLoop(loopCheck.checked);
      scene.persistStage();
    }
  });

  speedSelect.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (sprite) {
      sprite.model.setSpeed(Number(speedSelect.value));
      scene.persistStage();
    }
  });

  opacityRange.addEventListener("input", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.opacity = Number(opacityRange.value) / 100;
    opacityValue.textContent = `${Math.round(sprite.opacity * 100)}%`;
    scene.applySpriteColor(sprite);
    scene.persistStage();
  });

  scaleRange.addEventListener("input", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    const v = Number(scaleRange.value);
    sprite.model.layoutConfig.scale = v;
    scaleValue.textContent = `${v.toFixed(2)}×`;
    scene.stageRenderer.resize();
    updateEditOverlays();
    scene.persistStage();
  });

  tintColor.addEventListener("input", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.tint = tintColor.value;
    scene.applySpriteColor(sprite);
    scene.persistStage();
  });

  brightnessRange.addEventListener("input", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.brightness = Number(brightnessRange.value) / 100;
    brightnessValue.textContent = `${brightnessRange.value}%`;
    scene.applySpriteColor(sprite);
    scene.persistStage();
  });

  // Per-channel RGB balance sliders.
  const wireChannel = (range, valueEl, channel) => {
    range.addEventListener("input", () => {
      const sprite = getActiveSprite();
      if (!sprite) return;
      sprite.rgb = sprite.rgb || { r: 1, g: 1, b: 1 };
      sprite.rgb[channel] = Number(range.value) / 100;
      valueEl.textContent = `${range.value}%`;
      scene.applySpriteColor(sprite);
      scene.persistStage();
    });
  };
  wireChannel(colorRRange, colorRValue, "r");
  wireChannel(colorGRange, colorGValue, "g");
  wireChannel(colorBRange, colorBValue, "b");

  mirrorCheck.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.model.setMirror(mirrorCheck.checked);
    scene.persistStage();
  });

  resetBtn.addEventListener("click", () => scene.resetStage());
  resetEditsBtn.addEventListener("click", () => scene.resetEdits());

  // Scene controls.
  scenesBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    rebuildScenesPanel();
    scenesPanel.classList.toggle("hidden");
  });
  scenesNewBtn.addEventListener("click", () => {
    createNewScene();
    scenesPanel.classList.add("hidden");
  });

  // Layer controls.
  layerSelect.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    scene.setSpriteLayer(sprite.id, layerSelect.value);
  });
  layersBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    rebuildLayersPanel();
    layersPanel.classList.toggle("hidden");
  });
  layersAddBtn.addEventListener("click", () => {
    const name = layersNewName.value.trim();
    if (!name) return;
    scene.addLayer(name);
    layersNewName.value = "";
  });
  layersNewName.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") layersAddBtn.click();
  });

  // Settings panel toggle (persisted).
  panelToggle.addEventListener("click", () => setPanelCollapsed(true));
  panelOpen.addEventListener("click", () => setPanelCollapsed(false));

  // Audio controls.
  audioAddBtn.addEventListener("click", () => audioUploadInput.click());
  audioUploadInput.addEventListener("change", () => {
    const file = audioUploadInput.files && audioUploadInput.files[0];
    audioUploadInput.value = ""; // allow re-selecting the same file
    const sprite = getActiveSprite();
    if (!file || !sprite) return;
    uploadCustomAudio(sprite, file);
  });
  document.addEventListener("click", (ev) => {
    if (!layersPanel.classList.contains("hidden") && !layersPanel.contains(ev.target)) {
      layersPanel.classList.add("hidden");
    }
    if (!scenesPanel.classList.contains("hidden") && !scenesPanel.contains(ev.target)) {
      scenesPanel.classList.add("hidden");
    }
  });
  audioCatWrap.addEventListener("click", (ev) => {
    const act = ev.target.closest("[data-act]");
    if (!act) return;
    const sprite = getActiveSprite();
    if (!sprite || !sprite.audioEntry || !sprite.audioEntry.categories.size) return;
    if (act.dataset.act === "all") sprite.audioCategories = new Set(sprite.audioEntry.categories.keys());
    else sprite.audioCategories = new Set();
    rebuildAudioPanel();
    scene.persistStage();
  });
  audioMute.addEventListener("change", () => {
    const sprite = getActiveSprite();
    if (!sprite) return;
    sprite.muted = audioMute.checked;
    if (sprite.muted && sprite.audio) {
      try {
        sprite.audio.pause();
      } catch {}
      sprite.audio = null;
    }
    scene.persistStage();
  });
  audioVolumeRange.addEventListener("input", () => {
    scene.audioVolume = Number(audioVolumeRange.value) / 100;
    scene.persistStage();
  });

  // Guides + preview.
  guidesSelect.addEventListener("change", applyGuides);
  previewBtn.addEventListener("click", () => setPreview(!document.body.classList.contains("preview")));
  // Export: current scene -> one combined folder (Wallpaper Engine + Octos
  // metadata; Lively generates its own LivelyInfo.json on import) + a .zip for
  // Octos, then offer/perform the open-folder step.
  exportBtn.addEventListener("click", exportCurrentScene);
  openFolderBtn.addEventListener("click", () => {
    if (lastExportName) openExportedFolder(lastExportName);
  });

  backgroundSelect.addEventListener("change", () => {
    const v = backgroundSelect.value;
    if (v === "image") {
      // "Image / Video…" opens the file picker; revert the select until an
      // image/video lands.
      backgroundSelect.value = scene.bgMode;
      backgroundFile.click();
      return;
    }
    scene.bgMode = v;
    if (v === "custom") scene.bgColor = backgroundColorInput.value;
    else if (v === "#0f1115" || v === "#ffffff") scene.bgColor = v;
    scene.applyBackground();
  });

  backgroundColorInput.addEventListener("input", () => {
    scene.bgMode = "custom";
    scene.bgColor = backgroundColorInput.value;
    scene.applyBackground();
  });

  backgroundFile.addEventListener("change", () => {
    const file = backgroundFile.files && backgroundFile.files[0];
    backgroundFile.value = ""; // allow re-selecting the same file
    if (!file) return; // dialog cancelled — select already reverted
    scene.applyBgImage(file);
  });

  // Responsive: refit every sprite + guides on window/stage resize.
  const resizeHandler = () => {
    scene.stageRenderer.resize();
    updateGuidesOverlay();
    updateEditOverlays();
    fitPickerStrips();
  };
  window.addEventListener("resize", resizeHandler);
  const stageObserver = new ResizeObserver(resizeHandler);
  stageObserver.observe(stage);
  requestAnimationFrame(resizeHandler);
}

/** Keyboard shortcuts.
 *  - Esc: exit preview, else close the picker.
 *  - F:   toggle preview (entering preview always leaves edit mode).
 *  - E:   toggle edit mode.
 *  - A:   open the picker in add/remove mode.
 *  - G:   cycle aspect-ratio guides.
 *  Stage keys (delete / arrows / zoom) act on the active sprite.
 *  Guards: while the modal picker is open only Esc/F act; while in preview
 *  only Esc/F act; keys are ignored while typing in a field. */
function onKeyDown(ev) {
  if (ev.key === "Escape") {
    if (document.body.classList.contains("preview")) {
      setPreview(false);
      return;
    }
    closePicker();
    return;
  }
  const tag = (ev.target.tagName || "").toLowerCase();
  const typing =
    tag === "input" || tag === "textarea" || tag === "select" || ev.target.isContentEditable;
  if (typing) return;

  const inPreview = document.body.classList.contains("preview");
  const pickerOpen = !picker.classList.contains("hidden");

  // Preview is a viewing mode: only F (toggle it off) is meaningful there.
  if (inPreview) {
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      setPreview(false);
    }
    return;
  }

  if (ev.key === "f" || ev.key === "F") {
    // setPreview(true) turns edit mode off and hides the picker.
    ev.preventDefault();
    setPreview(true);
    return;
  }
  // The picker is a fullscreen modal — it owns the keyboard while open.
  if (pickerOpen) return;

  if (ev.key === "e" || ev.key === "E") {
    // preventDefault so the letter is never typed into a field that the
    // action itself focuses (A opens the picker and focuses its search box).
    ev.preventDefault();
    setEditMode(!editMode);
    return;
  }
  if (ev.key === "a" || ev.key === "A") {
    ev.preventDefault();
    openPicker("add");
    return;
  }
  if (ev.key === "g" || ev.key === "G") {
    ev.preventDefault();
    cycleGuides();
    return;
  }
  const sprite = getActiveSprite();
  if (ev.key === "Delete" || ev.key === "Backspace") {
    ev.preventDefault();
    if (sprite) scene.removeSprite(sprite.id);
    return;
  }
  if (!sprite) return;
  if (ev.key.startsWith("Arrow")) {
    ev.preventDefault();
    pinSprite(sprite);
    const cfg = sprite.model.layoutConfig;
    const { w, h } = canvasSize();
    const step = ev.shiftKey ? 10 : 1;
    const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
    const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
    const dirX = sprite.model.mirror ? -1 : 1;
    cfg.x = (cfg.x ?? 0.5) + (dx / w) * dirX;
    cfg.y = (cfg.y ?? 0.5) + dy / h;
    scene.stageRenderer.resize();
    updateEditOverlays();
    scene.persistStage();
    return;
  }
  if (ev.key === "+" || ev.key === "=") {
    ev.preventDefault();
    scaleActiveSprite(1.1);
    return;
  }
  if (ev.key === "-" || ev.key === "_") {
    ev.preventDefault();
    scaleActiveSprite(1 / 1.1);
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

buildPicker();
populateSpeedSelect();
wireEvents();
restoreGuides();
restorePanelState();
initScenes().then(() => {
  requestAnimationFrame(() => {
    scene.stageRenderer.resize();
    updateEditOverlays();
  });
});

// Debug / automation handle (used by the e2e test; harmless in production).
window.__spineViewer = {
  // Unique per page load — lets tests wait until a reloaded document is live.
  bootId: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
  CHARACTERS,
  thumbnailer,
  picker,
  get player() {
    return getActivePlayer();
  },
  get players() {
    return [...scene.sprites.values()].map((s) => s.model);
  },
  get activeCanvas() {
    return stageCanvas;
  },
  get activeId() {
    return scene.activeSpriteId;
  },
  get stage() {
    return scene.stageRenderer;
  },
  /** Centre of the active sprite's on-screen rect, in canvas-relative CSS px. */
  get activeCenter() {
    const model = getActivePlayer();
    const cw = stageCanvas.clientWidth || 1;
    const ch = stageCanvas.clientHeight || 1;
    const m = model ? model.modelRect(cw, ch) : null;
    return m ? { x: (m.left + m.right) / 2, y: (m.top + m.bottom) / 2 } : { x: cw / 2, y: ch / 2 };
  },
  sprites() {
    return [...scene.sprites.values()].map((s) => ({
      id: s.id,
      characterId: s.characterId,
      kind: s.kind,
      variant: s.variant,
      layer: s.layer,
      muted: s.muted,
      hasAudio: !!s.audioEntry,
      audioSnippet: s.audioSnippet ? { ...s.audioSnippet } : null,
      categories: s.audioEntry ? [...s.audioEntry.categories.keys()] : [],
      audioCategories: [...s.audioCategories],
    }));
  },
  get audioVolume() {
    return scene.audioVolume;
  },
  get audioCatalog() {
    return scene.audioCatalog;
  },
  addSprite: (id, opts) => scene.addSprite(id, opts),
  removeSprite: (id) => scene.removeSprite(id),
  selectCharacter,
  /** Set (object) or clear (null) the active/any sprite's audio snippet. */
  setAudioSnippet: (id, snip) => scene.setAudioSnippet(id, snip),
  background: {
    applyBgImage: (file) => scene.applyBgImage(file),
    get bgMode() {
      return scene.bgMode;
    },
  },
  scenes: {
    list: () => (scenesData ? scenesData.list.map((r) => ({ id: r.id, name: r.name })) : []),
    current: () => currentSceneId,
    create: (name) => createNewScene(name),
    switch: (id) => switchScene(id),
    rename: (id, name) => renameScene(id, name),
    remove: (id) => deleteScene(id),
  },
  layers: {
    list: () => scene.layers.map((l) => ({ ...l })),
    add: (name) => scene.addLayer(name),
    remove: (id) => scene.removeLayer(id),
    rename: (id, name) => scene.renameLayer(id, name),
    reorder: (id, index) => scene.reorderLayer(id, index),
    setSprite: (spriteId, layerId) => scene.setSpriteLayer(spriteId, layerId),
  },
  content: {
    /** Current + default content dirs ({ dir, defaultDir }) or null. */
    get: () =>
      fetch("api/content", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    /** Switch the server content root; resolves to the result dir on success
     *  or an error string. Does NOT reload — callers decide. */
    set: async (dir) => {
      try {
        const r = await fetch("api/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir }),
        });
        const d = await r.json().catch(() => null);
        return r.ok && d && d.ok ? d : (d && d.error) || `HTTP ${r.status}`;
      } catch (err) {
        return String(err && err.message ? err.message : err);
      }
    },
  },
  guides: {
    set: (v) => {
      guidesSelect.value = v;
      applyGuides();
    },
    get value() {
      return guidesSelect.value;
    },
    overlayShown: () => !guidesOverlay.classList.contains("hidden"),
  },
  preview: {
    toggle: () => setPreview(!document.body.classList.contains("preview")),
    set: (on) => setPreview(on),
    get on() {
      return document.body.classList.contains("preview");
    },
  },
};
