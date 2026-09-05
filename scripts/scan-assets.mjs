#!/usr/bin/env node
/**
 * Shared asset scanner — builds the character manifest from the FOLDER
 * structure of the content library.
 *
 * Used by:
 *   - scripts/generate-manifest.mjs  (writes src/manifest.js fallback)
 *   - scripts/serve.mjs              (serves GET /api/manifest dynamically)
 *
 * Nothing here is hard-coded to a specific content root or asset catalogue:
 * the picker's tabs/subtabs are generated from the folders the assets live
 * in, so dropping in a new folder (or removing one) changes the picker on the
 * next load with no code or manifest change.
 *
 * Layout rules (v1 — everything is derived from folders):
 *
 *   1. Content root (default `content/`) — every direct child folder becomes
 *      a TAB. Hidden entries (starting with ".") are ignored.
 *
 *   2. A direct child of a tab that holds its OWN asset — a Live2D model
 *      (.model3.json) or a base Spine skeleton `<name>_00.skel` + `.atlas`
 *      — is ONE picker item (a character card), NOT a subtab. Its subfolders
 *      are either Spine variants (e.g. `aim/`, `cover/`) or model resources
 *      (motions/expressions/textures/…) and are never listed separately.
 *
 *   3. Any other direct child of a tab is a SUBTAB. Everything under it (any
 *      depth) is scanned with the same rules and belongs to that subtab —
 *      deeper folders fold up into it instead of nesting further.
 *
 *   4. Items:
 *      - Live2D: each `.model3.json` file is one item.
 *      - Spine base folder: `<name>_00.skel`(+`.atlas`) is variant "normal";
 *        a subfolder `<v>/` holding `<name>_<v>_00.skel` (or such a file flat
 *        at the folder root) becomes variant `<v>`; other complete pairs in
 *        the folder become variants named after their stem.
 *      - Spine loose skeleton: any other `.skel`(+matching `.atlas`) pair is
 *        its own item.
 *      - Media: PNG/JPEG/WebP images, animated GIFs and WebM/MP4 videos are
 *        per-file items ONLY in folders that contain no `.skel` — a media
 *        file next to a skeleton is that skeleton's texture page (`.atlas`
 *        textures, multi-page `name_2.png`, …) and is never listed.
 *      - Audio: recognised per-asset audio files sit next to their asset and
 *        are attached to it; they are never standalone items.
 *
 * Every entry is tagged with `tab` (the content-root folder) and `subtab`
 * (the tab's immediate subfolder, or null when the item sits at the tab
 * root), which the editor picker turns into tabs/subtabs.
 *
 * The .png names are read from the .atlas file at load time, so no png paths
 * are recorded. Variants that do not exist are simply omitted — the UI handles
 * missing variants gracefully.
 */
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const isDir = (p) => statSync(p).isDirectory();

/** Audio file extensions accepted as custom per-asset audio. */
const AUDIO_EXTS = [".wav", ".mp3", ".ogg", ".m4a"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];
const GIF_EXTS = [".gif"];
const VIDEO_EXTS = [".webm", ".mp4"];

/** Sorted non-hidden entries of a folder (optionally filtered by type). */
function entriesOf(fsDir, only) {
  return readdirSync(fsDir)
    .filter((f) => !f.startsWith("."))
    .filter((f) => (only === "dirs" ? isDir(join(fsDir, f)) : only === "files" ? !isDir(join(fsDir, f)) : true))
    .sort();
}

/** Files directly in `fsDir` whose lower-cased name ends with `ext`. */
function filesWithExt(fsDir, ext) {
  const lower = ext.toLowerCase();
  return entriesOf(fsDir, "files").filter((f) => f.toLowerCase().endsWith(lower));
}

/**
 * Legacy Live2D (Cubism 2) model folder? Cubism 2 is the older model.json
 * format (a `model.json` referencing `model.moc`, `motions/*.mtn`,
 * `textures/*.png`, `expressions/*.exp.json`). Such models CANNOT be rendered
 * by the licensed Cubism 3/4/5 runtime, but their folders must still be
 * recognized as model folders so their texture pages are never listed as
 * standalone media. Signature: a `.moc` binary anywhere in the folder, or a
 * `model.json` next to `.mtn` motion files.
 */
function isLegacyLive2dFolder(fsDir) {
  if (filesWithExt(fsDir, ".moc").length) return true;
  return existsSync(join(fsDir, "model.json")) && filesWithExt(fsDir, ".mtn").length > 0;
}

function hasPair(fsDir, stem) {
  return existsSync(join(fsDir, `${stem}.skel`)) && existsSync(join(fsDir, `${stem}.atlas`));
}

/** Read only the first bytes of a file as utf8 (cheap content sniffing). */
function fileHead(fsPath, max = 1024) {
  let fd;
  try {
    fd = openSync(fsPath, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Spine JSON skeleton pairs in a folder: `<stem>.json` + `<stem>.atlas`
 * sitting side by side, where the .json starts with a "skeleton" block.
 * Returns the stems. Only consulted when a folder holds no binary .skel.
 */
function jsonSkeletonStems(fsDir) {
  const stems = [];
  for (const f of entriesOf(fsDir, "files")) {
    const lower = f.toLowerCase();
    if (!lower.endsWith(".json")) continue;
    const stem = f.slice(0, lower.length - 5);
    if (!existsSync(join(fsDir, `${stem}.atlas`))) continue;
    if (/"(skeleton|skins|bones)"/.test(fileHead(join(fsDir, f)))) stems.push(stem);
  }
  return stems;
}

/** True when `<stem>.json`(+`.atlas`) is a Spine JSON skeleton pair. */
function hasJsonSkeletonPair(fsDir, stem) {
  if (!existsSync(join(fsDir, `${stem}.atlas`))) return false;
  const jf = join(fsDir, `${stem}.json`);
  if (!existsSync(jf)) return false;
  return /"(skeleton|skins|bones)"/.test(fileHead(jf));
}

/**
 * Attach custom-audio metadata to an item: audio files that sit in the same
 * folder as the asset with the asset's base name (e.g. c010_00.wav next to
 * c010_00.skel), with numbers appended for more files (c010_01.wav, …). The
 * upload UI uses audioBase/audioDir to name new files; the audio catalog uses
 * `audio` to find existing ones.
 */
function attachAudio(item, fsDir, base, urlDir) {
  item.audioBase = base;
  item.audioDir = urlDir;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(?:_\\d+)?\\.(wav|mp3|ogg|m4a)$`);
  try {
    const files = readdirSync(fsDir)
      .filter((f) => pattern.test(f))
      .sort();
    if (files.length) item.audio = files.map((f) => `${urlDir}/${f}`);
  } catch {
    // folder vanished — leave audio unset
  }
}

/**
 * Classify a folder:
 *   "models"    — contains ≥1 .model3.json (a Live2D model folder)
 *   "spineBase" — contains `<dirname>_00.skel` + `.atlas` (a Spine character)
 *   "container" — anything else (a subtab/grouping or loose-asset folder)
 */
function folderKind(fsDir, dirName) {
  if (filesWithExt(fsDir, ".model3.json").length) return "models";
  // Legacy Live2D (Cubism 2) model folders share the "one folder = one model"
  // layout; they are recognized so their textures stay model resources.
  if (isLegacyLive2dFolder(fsDir)) return "models";
  if (hasPair(fsDir, `${dirName}_00`)) return "spineBase";
  // Spine JSON base: a `<dirname>.json` + `.atlas` pair (game rips that ship
  // JSON skeletons instead of binary .skel).
  if (hasJsonSkeletonPair(fsDir, dirName)) return "spineBase";
  return "container";
}

/**
 * Emit item(s) for a single-asset folder (layout rule 2 above).
 * @param {string} fsDir   folder path
 * @param {string} dirName folder basename
 * @param {string} relDir  folder path relative to the tab root ("" for the tab root itself)
 * @param {string} tabName content-root folder (the tab)
 * @param {string|null} subtab owning subtab folder, or null when the item sits at the tab root
 */
function collectUnit(fsDir, dirName, relDir, tabName, subtab, characters, warnings) {
  const urlBase = `${tabName}${relDir ? `/${relDir}` : ""}`;
  const idPrefix = relDir ? `${relDir}/` : "";
  const where = `${tabName}${relDir ? `/${relDir}` : ""}`;

  // Live2D: every .model3.json in the folder is its own item.
  const models = filesWithExt(fsDir, ".model3.json");
  if (models.length) {
    for (const file of models) {
      const stem = file.slice(0, -".model3.json".length);
      characters.push({
        id: `${idPrefix}${stem}`,
        name: stem,
        kind: "live2d",
        live2dVersion: 3,
        tab: tabName,
        subtab: subtab ?? null,
        url: `${urlBase}/${file}`,
      });
    }
    return;
  }

  // Legacy Live2D (Cubism 2, model.json + .moc/.mtn): one picker item per
  // model folder. The runtime cannot render Cubism 2, so the item carries no
  // loadable url — the editor shows an unsupported-format hint instead of
  // adding it, and the folder's texture pages are never listed as media.
  if (isLegacyLive2dFolder(fsDir)) {
    characters.push({
      id: idBase(idPrefix, dirName),
      name: dirName,
      kind: "live2d",
      live2dVersion: 2,
      tab: tabName,
      subtab: subtab ?? null,
    });
    return;
  }

  // Spine base folder: variant "normal" from `<name>_00.skel`, plus
  // `<v>` variants found in a subfolder `<v>/<name>_<v>_00.skel` or flat at
  // the folder root as `<name>_<v>_00.skel`. JSON bases (game rips that
  // export `<name>.json` + `<name>.atlas`, or JSON misnamed as .skel) use the
  // folder name as their stem — the player content-sniffs JSON vs binary.
  const jsonBase = hasJsonSkeletonPair(fsDir, dirName);
  const dirStem = jsonBase ? dirName : `${dirName}_00`;
  const variants = {
    normal: {
      skel: `${urlBase}/${dirStem}.${jsonBase ? "json" : "skel"}`,
      atlas: `${urlBase}/${dirStem}.atlas`,
    },
  };

  for (const sub of entriesOf(fsDir, "dirs")) {
    const subDir = join(fsDir, sub);
    if (hasPair(subDir, `${dirName}_${sub}_00`)) {
      const stem = `${dirName}_${sub}_00`;
      variants[sub] = { skel: `${urlBase}/${sub}/${stem}.skel`, atlas: `${urlBase}/${sub}/${stem}.atlas` };
    } else if (hasJsonSkeletonPair(subDir, `${dirName}_${sub}`)) {
      const stem = `${dirName}_${sub}`;
      variants[sub] = { skel: `${urlBase}/${sub}/${stem}.json`, atlas: `${urlBase}/${sub}/${stem}.atlas` };
    }
  }
  for (const file of filesWithExt(fsDir, ".skel")) {
    const stem = file.slice(0, -5);
    if (!hasPair(fsDir, stem)) {
      warnings.push(`${where}: atlas missing for ${file} — skipped`);
      continue;
    }
    if (stem === dirStem) continue;
    // `<name>_<v>_00` pairs become variant `<v>` (aim/cover/…); any other
    // complete pair sitting in the folder becomes a variant named after the
    // skeleton stem so no real asset is silently dropped.
    const m = stem.match(new RegExp(`^${dirName}_(.+)$`));
    const key = m ? m[1] : stem;
    if (!variants[key]) {
      variants[key] = { skel: `${urlBase}/${stem}.skel`, atlas: `${urlBase}/${stem}.atlas` };
    }
  }

  const character = {
    id: idBase(idPrefix, dirName),
    name: dirName,
    variants,
    tab: tabName,
    subtab: subtab ?? null,
  };
  attachAudio(character, fsDir, dirStem, urlBase);
  characters.push(character);
}

function idBase(idPrefix, dirName) {
  return idPrefix ? idPrefix.slice(0, -1) : dirName;
}

/**
 * Emit per-file items found directly in `fsDir` (media files and loose Spine
 * skeleton pairs). Audio files are attached to items, never listed alone.
 *
 * A folder that directly contains a `.skel` file (or a Spine JSON
 * skeleton pair: `<stem>.json` + `<stem>.atlas` where the JSON opens with a
 * "skeleton" block) is treated as a SPINE folder: images/GIFs/videos there are
 * supporting files (the texture page(s) the `.atlas` references, incl.
 * multi-page `name_2.png`, `name_3.png`, …) and are NOT listed as separate
 * items. Put standalone media in folders that contain no skeletons.
 */
function collectFileItems(fsDir, relDir, tabName, subtab, characters, warnings) {
  const urlBase = `${tabName}${relDir ? `/${relDir}` : ""}`;
  const idPrefix = relDir ? `${relDir}/` : "";
  const where = `${tabName}${relDir ? `/${relDir}` : ""}`;
  // A folder is a SPINE folder when it holds a binary .skel OR a Spine JSON
  // skeleton pair. JSON pairs matter only when there is no binary skeleton (a
  // folder that HAS a .skel treats any JSON next to it as support data).
  const skelFiles = filesWithExt(fsDir, ".skel");
  let jsonStems = [];
  if (!skelFiles.length) jsonStems = jsonSkeletonStems(fsDir);
  const hasSkeleton = skelFiles.length > 0 || jsonStems.length > 0;

  for (const file of entriesOf(fsDir, "files")) {
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const stem = file.slice(0, file.length - ext.length);
    const make = (item) => {
      attachAudio(item, fsDir, stem, urlBase);
      characters.push(item);
    };
    if (hasSkeleton) {
      // Spine folder — only skeleton pairs become items below; media files
      // next to a skeleton are treated as its textures.
      if (ext === ".skel") {
        if (!existsSync(join(fsDir, `${stem}.atlas`))) {
          warnings.push(`${where}: atlas missing for ${file} — skipped`);
          continue;
        }
        make({
          id: `${idPrefix}${stem}`,
          name: stem,
          kind: "spine",
          tab: tabName,
          subtab,
          variants: { [stem]: { skel: `${urlBase}/${file}`, atlas: `${urlBase}/${stem}.atlas` } },
        });
      } else if (ext === ".json" && jsonStems.includes(stem)) {
        make({
          id: `${idPrefix}${stem}`,
          name: stem,
          kind: "spine",
          tab: tabName,
          subtab,
          variants: { [stem]: { skel: `${urlBase}/${file}`, atlas: `${urlBase}/${stem}.atlas` } },
        });
      }
      continue;
    }
    if (IMAGE_EXTS.includes(ext)) {
      make({ id: `${idPrefix}${stem}${ext}`, name: stem, kind: "image", tab: tabName, subtab, url: `${urlBase}/${file}` });
    } else if (GIF_EXTS.includes(ext)) {
      make({ id: `${idPrefix}${stem}${ext}`, name: stem, kind: "gif", tab: tabName, subtab, url: `${urlBase}/${file}` });
    } else if (VIDEO_EXTS.includes(ext)) {
      make({ id: `${idPrefix}${stem}${ext}`, name: stem, kind: "video", tab: tabName, subtab, url: `${urlBase}/${file}` });
    } else if (ext === ".skel") {
      if (!existsSync(join(fsDir, `${stem}.atlas`))) {
        warnings.push(`${where}: atlas missing for ${file} — skipped`);
        continue;
      }
      make({
        id: `${idPrefix}${stem}`,
        name: stem,
        kind: "spine",
        tab: tabName,
        subtab,
        variants: { [stem]: { skel: `${urlBase}/${file}`, atlas: `${urlBase}/${stem}.atlas` } },
      });
    }
  }
}

/**
 * Scan a container folder (rule 3): everything below it belongs to the same
 * subtab group. Files directly in it are items; child folders are visited
 * recursively — single-asset folders become items, deeper containers merge
 * into this same group (no extra nesting).
 */
function collectGroup(fsDir, relDir, tabName, subtab, characters, warnings) {
  collectFileItems(fsDir, relDir, tabName, subtab, characters, warnings);
  for (const entry of entriesOf(fsDir, "dirs")) {
    const p = join(fsDir, entry);
    const nextRel = relDir ? `${relDir}/${entry}` : entry;
    if (folderKind(p, entry) === "container") {
      collectGroup(p, nextRel, tabName, subtab, characters, warnings);
    } else {
      collectUnit(p, entry, nextRel, tabName, subtab, characters, warnings);
    }
  }
}

/**
 * Scan one top-level content folder (a picker TAB).
 * Direct child folders that hold their own asset become tab-level items; the
 * remaining direct child folders are subtab groups; loose files at the tab
 * root are tab-level items.
 */
function scanTab(fsTab, tabName, characters, warnings) {
  collectFileItems(fsTab, "", tabName, null, characters, warnings);
  for (const entry of entriesOf(fsTab, "dirs")) {
    const p = join(fsTab, entry);
    if (folderKind(p, entry) === "container") {
      collectGroup(p, entry, tabName, entry, characters, warnings);
    } else {
      collectUnit(p, entry, entry, tabName, null, characters, warnings);
    }
  }
}

/** Make ids unique across the whole library (a rare folder-layout edge). */
function ensureUniqueIds(characters) {
  const seen = new Set();
  for (const c of characters) {
    if (seen.has(c.id)) {
      let n = 2;
      while (seen.has(`${c.id}-${n}`)) n++;
      c.id = `${c.id}-${n}`;
    }
    seen.add(c.id);
  }
}

/**
 * Scan the whole library. Every direct child folder of the content root is a
 * tab (alphabetical). Entries are sorted by (tab, subtab, id) so the manifest
 * order is deterministic and stable across re-scans.
 * @param {string} contentDir the content/library root (default ./content)
 * @returns {{characters: Array, warnings: string[]}}
 */
export function scanContentRoot(contentDir) {
  const characters = [];
  const warnings = [];
  if (!existsSync(contentDir)) return { characters, warnings };

  for (const tabName of entriesOf(contentDir, "dirs")) {
    const before = characters.length;
    scanTab(join(contentDir, tabName), tabName, characters, warnings);
    if (characters.length === before) {
      warnings.push(`${tabName}: no supported assets found in this folder`);
    }
  }
  ensureUniqueIds(characters);
  characters.sort(
    (a, b) =>
      (a.tab ?? "").localeCompare(b.tab ?? "") ||
      (a.subtab ?? "").localeCompare(b.subtab ?? "") ||
      a.id.localeCompare(b.id)
  );
  return { characters, warnings };
}
