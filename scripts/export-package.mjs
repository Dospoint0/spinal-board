#!/usr/bin/env node
/**
 * export-package.mjs — builds ONE self-contained interactive wallpaper folder
 * usable by all three wallpaper managers (Wallpaper Engine, Lively, Octos).
 *
 * The output package is fully offline and static:
 *   - index.html is the canonical entry (the scene — sprites, layers,
 *     background, audio volume — is baked into it as inline JSON): no
 *     localStorage, IndexedDB, dynamic manifest or network in the result;
 *   - only the referenced content files are copied (never the whole library),
 *     with their tab-relative URLs remapped into the package:
 *       assets/…   all non-audio asset files (skeletons, atlases, textures,
 *                  media, whole Live2D model folders)
 *       audio/…    per-asset audio files
 *   - the wallpaper runtime is the esbuild template bundle (dist/template/
 *     wallpaper.js) with the Spine runtimes it needs (they are our vendored
 *     runtimes — copied, never linked from the repo);
 *   - cubism/ ships EMPTY with instructions (the licensed Cubism runtime is
 *     user-provided, never distributed) — Live2D sprites degrade gracefully;
 *   - one folder, three managers' metadata, all pointing at index.html:
 *       project.json    — Wallpaper Engine (type "web", file "index.html")
 *       LivelyInfo.json — Lively (Type "web", FileName "index.html")
 *       octos.json      — Octos (entry "index.html")
 *     plus a ready <name>.zip of the folder (Octos installs from .zip).
 *
 * The dev server exposes this as POST /api/export (see serve.mjs); the module
 * is also usable standalone.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, normalize, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { scanContentRoot } from "./scan-assets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Resolve an LWPG_* path override. path.join does NOT reset when the second
 * segment is absolute (an absolute override silently became <ROOT>/<abs>);
 * honour absolute values verbatim instead, exactly as the packaged Electron
 * app needs when it points content/exports at Documents\SpinalBoard\….
 */
function envDir(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? (isAbsolute(v) ? v : join(ROOT, v)) : join(ROOT, fallback);
}

export const CONTENT_DIR = envDir("LWPG_CONTENT", "content");

/** Export root: env LWPG_EXPORTS, else <repo>/exports (git-ignored). */
export function exportRootDir() {
  return envDir("LWPG_EXPORTS", "exports");
}

const AUDIO_EXTS = new Set([".wav", ".mp3", ".ogg", ".m4a"]);
const URL_KINDS = new Set(["image", "video", "gif", "live2d"]);

export const isAudioPath = (p) =>
  AUDIO_EXTS.has(extname(String(p).split("?")[0]).toLowerCase());

/** A filesystem-safe, readable folder name for a scene. */
export function sanitizeSceneName(name) {
  let s = String(name || "scene")
    .trim()
    .replace(/[^A-Za-z0-9_. -]+/g, "-")
    .replace(/[ ]+/g, " ")
    .trim()
    .slice(0, 60);
  s = s.replace(/^[^A-Za-z0-9]+/, ""); // never start with a dot/dash
  return s || "scene";
}

/** Content-relative URL -> package-relative path (assets/… or audio/…). */
function remapUrl(url) {
  const clean = String(url || "").replace(/^\/+/, "");
  return isAudioPath(clean) ? `audio/${clean}` : `assets/${clean}`;
}

const isDir = (p) => statSync(p).isDirectory();

/** Copy every file of a folder tree (recursively, no hidden entries). */
function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    if (f.startsWith(".")) continue;
    const s = join(srcDir, f);
    if (isDir(s)) copyTree(s, join(destDir, f));
    else copyFileSync(s, join(destDir, f));
  }
}

/**
 * Build one exported package folder.
 * @param {object} opts
 * @param {string} opts.name scene name (folder is sanitized)
 * @param {object} opts.scene the editor scene state (sprites/layers/bg/…)
 * @param {{ext:string,data:Buffer,video:boolean}|null} opts.bgFile optional
 *        background image/video bytes (the editor holds these in a blob that
 *        the server cannot otherwise see)
 * @param {string} [opts.contentDir]
 * @param {string} [opts.exportDir]
 * @returns {Promise<{name:string, folderName:string, folder:string,
 *            path:string, zip:string, files:number, bytes:number,
 *            zipBytes:number, sprites:number}>}
 */
export async function buildPackage(opts) {
  const { name, scene, bgFile = null } = opts;
  const contentDir = opts.contentDir || CONTENT_DIR;
  const exportDir = opts.exportDir || exportRootDir();
  if (!scene || !Array.isArray(scene.sprites)) {
    throw new Error("export needs a scene state with a sprites array");
  }
  const { characters } = scanContentRoot(contentDir);
  const byId = new Map(characters.map((c) => [c.id, c]));

  const folderName = sanitizeSceneName(name);
  const folder = join(exportDir, folderName);
  rmSync(folder, { recursive: true, force: true });
  const dirs = ["assets", "audio", "runtime", "cubism"];
  for (const d of dirs) mkdirSync(join(folder, d), { recursive: true });

  const copied = new Map(); // abs source -> package dest path
  const registry = new Map(); // charId -> packaged entry
  let spineUsed = false;
  let bytes = 0;

  const queueCopy = (absSrc) => {
    if (!existsSync(absSrc)) return null;
    if (copied.has(absSrc)) return copied.get(absSrc);
    const rel = remapUrl(normalize(absSrc).slice(normalize(contentDir).length + 1).split("\\").join("/"));
    const dest = join(folder, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(absSrc, dest);
    bytes += statSync(absSrc).size;
    copied.set(absSrc, rel);
    return rel;
  };

  /** Copy every top-level file inside the folder holding `relUrl`. */
  const queueFolderFiles = (relUrl, includeAudio) => {
    const fsDir = join(contentDir, dirname(relUrl));
    if (!existsSync(fsDir)) return [];
    const out = [];
    for (const f of readdirSync(fsDir)) {
      if (f.startsWith(".")) continue;
      const abs = join(fsDir, f);
      if (isDir(abs)) continue;
      if (isAudioPath(f) && !includeAudio) continue;
      const dest = queueCopy(abs);
      if (dest) out.push(dest);
    }
    return out;
  };

  /** Registry + copy plan for ONE sprite's character. Returns entry or null. */
  const planCharacter = (sprite) => {
    const id = sprite.characterId;
    if (registry.has(id)) return registry.get(id);
    const char = byId.get(id);
    if (!char) return null;

    const kind = URL_KINDS.has(char.kind) ? char.kind : "spine";
    let entry;

    if (kind === "spine") {
      spineUsed = true;
      const variant =
        char.variants && sprite.variant && char.variants[sprite.variant]
          ? sprite.variant
          : char.variants
            ? Object.keys(char.variants).find((v) => v === "normal") ?? Object.keys(char.variants)[0]
            : "normal";
      const v = char.variants?.[variant];
      if (!v) return null;
      const skel = queueCopy(join(contentDir, v.skel));
      const atlas = queueCopy(join(contentDir, v.atlas));
      // Textures + other support files live next to the skeleton; audio
      // siblings (per-asset voice lines) go to the audio/ tree.
      queueFolderFiles(v.skel, false);
      queueFolderFiles(v.skel, true);
      const audio = (char.audio || [])
        .map((u) => queueCopy(join(contentDir, u)))
        .filter(Boolean);
      entry = { id, name: char.name, kind: "spine", variant, variants: { [variant]: { skel, atlas } }, audio };
    } else if (kind === "live2d") {
      // Whole model folder (moc3, textures, motions, pose/physics, …) — a
      // model needs all of it. Live2D is experimental/unsupported; the
      // exported wallpaper degrades to a placeholder until the user supplies
      // the Cubism runtime into cubism/.
      const fsModel = join(contentDir, char.url);
      const modelDir = dirname(fsModel);
      copyTree(modelDir, join(folder, `assets/${dirname(char.url)}`));
      bytes += treeBytes(modelDir);
      const url = queueCopy(fsModel);
      const audio = (char.audio || [])
        .map((u) => queueCopy(join(contentDir, u)))
        .filter(Boolean);
      entry = { id, name: char.name, kind: "live2d", live2dVersion: char.live2dVersion ?? 3, url, audio };
    } else {
      const url = queueCopy(join(contentDir, char.url));
      const audio = (char.audio || [])
        .map((u) => queueCopy(join(contentDir, u)))
        .filter(Boolean);
      entry = { id, name: char.name, kind, url, audio };
    }
    registry.set(id, entry);
    return entry;
  };

  function treeBytes(dir) {
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".")) continue;
      const p = join(dir, f);
      if (isDir(p)) n += treeBytes(p);
      else n += statSync(p).size;
    }
    return n;
  }

  // ---- Sprites: plan copies, prune unresolvable ones, remap snippets ----
  const sprites = [];
  for (const sprite of scene.sprites || []) {
    if (!sprite || !sprite.characterId) continue;
    const entry = planCharacter(sprite);
    if (!entry) continue;
    const copy = { ...sprite };
    // audioSnippet.file is a content-relative URL; remap it into the package
    // (snippet playback falls back to it when the file is no longer on the
    // sprite's manifest audio list).
    if (copy.audioSnippet && copy.audioSnippet.file) {
      const f = String(copy.audioSnippet.file).replace(/^\/+/, "");
      if (existsSync(join(contentDir, f))) {
        copy.audioSnippet = { ...copy.audioSnippet, file: queueCopy(join(contentDir, f)) };
      }
    }
    sprites.push(copy);
  }

  // ---- Background -------------------------------------------------------
  const bgState = { ...(scene.bg || { mode: "transparent", color: "#000000" }) };
  if (bgFile && bgFile.data && bgFile.data.length && bgState.mode === "image") {
    const rel = `assets/bg.${String(bgFile.ext || "png").replace(/^\./, "")}`;
    writeFileSync(join(folder, rel), bgFile.data);
    bytes += bgFile.data.length;
    bgState.file = rel;
    bgState.video = !!bgFile.video;
  } else if (bgState.mode === "image") {
    // Editor has an image/video bg but no bytes reached the server — degrade
    // to the colour so the export never references a missing file.
    bgState.mode = "transparent";
  }

  // ---- Runtime (Spine runtimes are ours; copy when the scene uses Spine) --
  // All four supported runtimes are copied (3.7.94/3.8.95/4.0.31/4.1.56) —
  // the bundled wallpaper runtime picks the right one from each skeleton's
  // version header at load time, mirroring the editor.
  const spineScripts = [];
  if (spineUsed) {
    for (const file of [
      "spine-3.7.94",
      "spine-3.8.95",
      "spine-4.0.31",
      "spine-4.1.56",
    ]) {
      const src = join(ROOT, "vendor", file, "spine-webgl.global.js");
      const dest = join(folder, "runtime", `${file}.js`);
      copyFileSync(src, dest);
      bytes += statSync(src).size;
      spineScripts.push(`${file}.js`);
      const lic = join(ROOT, "vendor", file, "LICENSE");
      if (existsSync(lic)) {
        const ldest = join(folder, "runtime", `${file}.LICENSE.txt`);
        copyFileSync(lic, ldest);
        bytes += statSync(lic).size;
      }
    }
  }

  // ---- Packaged scene JSON ---------------------------------------------
  const baked = {
    name: folderName,
    characters: [...registry.values()],
    state: {
      ...scene,
      bg: bgState,
      sprites,
    },
  };

  const bakedJson = JSON.stringify(baked);
  bytes += bakedJson.length;

  // ---- index.html (canonical entry, scene baked inline) ------------------
  // index.html is the ONE entry all three managers load (Wallpaper Engine via
  // project.json.file, Lively via LivelyInfo.json.FileName, Octos via
  // octos.json.entry or its index.html auto-detection). Relative wallpaper.js
  // / runtime/* script paths stay unchanged.
  const scriptTags = spineScripts
    .map((s) => `  <script src="runtime/${s}"></script>`)
    .join("\n");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(folderName)}</title>
  <link rel="stylesheet" href="style.css" />
  <!-- Vendored Spine runtimes (3.7.x + 3.8.x + 4.0.x + 4.1.x, namespaced
       globals; the bundle dispatches by skeleton version header). Copied
       only when the scene uses Spine. -->
${scriptTags}
</head>
<body class="wallpaper">
  <!--
    Exported wallpaper: fully offline and static. The scene below is baked
    in — the runtime never touches localStorage, IndexedDB, a manifest
    endpoint or the network. Live2D sprites degrade to a placeholder unless
    you place your licensed Cubism runtime under cubism/ (see cubism/README.md).
  -->
  <main id="stage">
    <canvas id="stage-canvas"></canvas>
  </main>
  <script id="lwpg-scene" type="application/json">${bakedJson}</script>
  <script type="module" src="wallpaper.js"></script>
</body>
</html>
`;
  writeFileSync(join(folder, "index.html"), html);

  // ---- wallpaper.js: the STATIC template bundle --------------------------
  // Exported packages ship dist/template-static/wallpaper.js (baked-scene-only
  // runtime: no manifest import, no storage, no URL override). Fall back to
  // the dev template if the static build is missing (stale dist/).
  const staticBundle = join(ROOT, "dist", "template-static", "wallpaper.js");
  const templateBundle = join(ROOT, "dist", "template", "wallpaper.js");
  const chosen = existsSync(staticBundle) ? staticBundle : templateBundle;
  if (!existsSync(chosen)) {
    throw new Error("missing dist/template(-static)/wallpaper.js — run `npm run build` first");
  }
  const bundleBytes = statSync(chosen).size;
  copyFileSync(chosen, join(folder, "wallpaper.js"));
  bytes += bundleBytes;

  // ---- style.css --------------------------------------------------------
  writeFileSync(join(folder, "style.css"), EXPORT_CSS);

  // ---- project.json (Wallpaper Engine web wallpaper) --------------------
  const project = {
    title: folderName,
    type: "web",
    file: "index.html",
    description: "Interactive live wallpaper exported by Spinal Board",
    tags: ["live", "animated"],
    contentrating: "Everyone",
    visibility: "private",
    general: {
      properties: {
        schemecolor: {
          order: 0,
          text: "ui_browse_properties_scheme_color",
          type: "color",
          value: "0 0 0 255",
        },
        fps: { order: 1, text: "fps", type: "int", value: 30, min: 10, max: 60 },
      },
    },
  };
  writeFileSync(join(folder, "project.json"), JSON.stringify(project, null, 2));

  // ---- LivelyInfo.json (Lively web wallpaper) ----------------------------
  // Keys mirror Lively's LivelyInfoModel.cs — note the model's short "Desc"
  // property name. Type is the WallpaperType enum serialized as a string.
  const livelyInfo = {
    Title: folderName,
    Desc: "Interactive live wallpaper exported by Spinal Board (click/hold + audio).",
    Author: "Spinal Board",
    FileName: "index.html",
    Type: "web",
  };
  writeFileSync(join(folder, "LivelyInfo.json"), JSON.stringify(livelyInfo, null, 2));

  // ---- octos.json (Octos mod metadata) -----------------------------------
  // Octos mods are a folder with an (optional) octos.json; entry points at the
  // same index.html. Fields kept minimal per the V1 contract.
  const octos = {
    name: folderName,
    description: "Interactive live wallpaper exported by Spinal Board (click/hold + audio).",
    entry: "index.html",
    author: "Spinal Board",
    version: "1.0.0",
  };
  writeFileSync(join(folder, "octos.json"), JSON.stringify(octos, null, 2));

  // ---- cubism/ (empty + instructions; never the runtime) ----------------
  writeFileSync(
    join(folder, "cubism", "README.md"),
    [
      "# Cubism runtime (Live2D)",
      "",
      "This folder is intentionally EMPTY. Live2D/Cubism rendering is an",
      "experimental, unsupported feature and the licensed Cubism runtime is",
      "NEVER distributed with exported wallpapers.",
      "",
      "If this wallpaper contains Live2D (Cubism 3/4/5) models and you want them",
      "to animate, copy your licensed Cubism SDK for Web runtime here so this",
      "folder mirrors what the runtime expects (relative to index.html):",
      "",
      "  cubism/Core/live2dcubismcore.min.js",
      "  cubism/Framework/live2d.min.js",
      "  cubism/Shaders/WebGL/*",
      "",
      "Without it, all other sprite kinds still render and Live2D sprites show a",
      "non-fatal placeholder. Cubism 2 (model.json/.moc) models are not",
      "supported at all and were excluded from this package.",
      "",
    ].join("\n")
  );

  // ---- <name>.zip (ready for Octos install) -------------------------------
  // V1 locked decision: PowerShell Compress-Archive on Windows (zero new
  // dependency). Dev/test on POSIX uses the system `zip` tool instead; the
  // archive contains the folder CONTENTS at its root (what the managers'
  // importers expect).
  const files = countFiles(folder);
  const zipPath = `${folder}.zip`;
  rmSync(zipPath, { force: true });
  await createZipOfDir(folder, zipPath);

  return {
    ok: true,
    name: folderName,
    folder,
    path: normalize(folder).split("\\").join("/"),
    zip: normalize(zipPath).split("\\").join("/"),
    files,
    bytes,
    zipBytes: statSync(zipPath).size,
    sprites: sprites.length,
  };
}

/**
 * Zip a folder's contents into zipPath.
 * - Windows (the packaged app): PowerShell Compress-Archive — zero new deps.
 * - POSIX (dev/test): the system `zip` tool.
 * @returns {Promise<string>} zipPath
 */
async function createZipOfDir(dir, zipPath) {
  if (process.platform === "win32") {
    const q = (p) => String(p).replace(/'/g, "''");
    const command =
      `Compress-Archive -Path '${q(join(dir, "*"))}' ` +
      `-DestinationPath '${q(zipPath)}' -CompressionLevel Optimal -Force`;
    await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    return zipPath;
  }
  try {
    await runTool("zip", ["-qr", zipPath, "."], { cwd: dir });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        "no zip tool available: install `zip` (POSIX dev/test) or export on Windows " +
          "(PowerShell Compress-Archive)"
      );
    }
    throw err;
  }
  return zipPath;
}

/** Spawn a tool and resolve when it exits 0; reject (with output) otherwise. */
function runTool(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code}): ${(errOut || out).trim()}`));
    });
  });
}

function countFiles(dir) {
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (isDir(p)) n += countFiles(p);
    else n++;
  }
  return n;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/** Best-effort open of a folder in the OS file manager (async, fire & forget). */
export function openInFileManager(absPath) {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", [absPath]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", absPath]]
        : ["xdg-open", [absPath]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Minimal stylesheet for the exported wallpaper (no editor chrome). */
const EXPORT_CSS = `/* Spinal Board — exported wallpaper */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
}
body.wallpaper #stage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
body.wallpaper #stage video.bg-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
body.wallpaper #stage-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: default;
  user-select: none;
  touch-action: none;
}
`;
