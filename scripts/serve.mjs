#!/usr/bin/env node
/**
 * Minimal zero-dependency static file server for development.
 *
 * Usage:  node scripts/serve.mjs [port]
 * Default port: 8080
 *
 * Serves the project root. Use any normal local HTTP server if you prefer
 * (e.g. `npx serve`); the app has no server-side requirements.
 *
 * Content layout: the content library lives under <content-root> (default
 * ./content). Every DIRECT FOLDER under it is a picker tab — the scanner and
 * the static alias below derive from whatever folders exist, so a new folder
 * dropped in appears as a new tab with no server changes. Each top-level
 * folder is served under its own URL prefix (/assets, /custom_assets, /live2d,
 * … — anything a user adds works the same). Set LWPG_CONTENT to point the
 * content root elsewhere (e.g. a sibling library folder). Hidden folders
 * (names starting with ".") are ignored.
 *
 * The content root can also be switched at RUNTIME from the editor's picker:
 * GET /api/content returns the current root, POST /api/content { dir } points
 * the root at another folder (an empty dir resets to the default/LWPG_CONTENT).
 * The renderer remembers the choice and re-applies it on the next load, so
 * this server holds only the session value.
 */
import { createServer } from "node:http";
import { readFile, stat, writeFile, unlink } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scanContentRoot } from "./scan-assets.mjs";
import { buildPackage, exportRootDir, openInFileManager } from "./export-package.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

/**
 * Resolve a LWPG_* override to an absolute dir. path.join does NOT reset on an
 * absolute second segment, so absolute values (e.g. the packaged app pointing
 * content/exports at Documents\SpinalBoard\…) must be honoured verbatim.
 */
function resolveEnvDir(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? (isAbsolute(v) ? v : join(ROOT, v)) : join(ROOT, fallback);
}

/** Content root: default ./content, overridable with LWPG_CONTENT (resolved
 *  once, then swappable at runtime via POST /api/content). */
function defaultContentDir() {
  return resolveEnvDir("LWPG_CONTENT", "content");
}
let CONTENT_DIR = defaultContentDir();

/**
 * Resolve a runtime content-folder request to an absolute directory.
 * - Empty/whitespace -> the default (reset).
 * - Absolute path -> used verbatim (must exist and be a directory).
 * - Relative path  -> resolved against the repo root (mirrors LWPG_CONTENT).
 * Leading/trailing quotes (pasted from Explorer) are stripped.
 * Returns null when the folder does not exist / is not a directory.
 */
function resolveLibraryDir(value) {
  const raw = String(value ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return defaultContentDir();
  const resolved = isAbsolute(raw) ? normalize(raw) : normalize(join(ROOT, raw));
  try {
    if (statSync(resolved).isDirectory()) return resolved;
  } catch {
    /* not a directory / missing */
  }
  return null;
}

/** Top-level content folders (picker tabs), as { name, fs } pairs. */
function libraryRoots() {
  if (!existsSync(CONTENT_DIR)) return [];
  return readdirSync(CONTENT_DIR)
    .filter((f) => !f.startsWith("."))
    .filter((f) => {
      try {
        return statSync(join(CONTENT_DIR, f)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({ name, fs: join(CONTENT_DIR, name) }));
}

/** Folders that may receive uploaded custom audio (any content tab). */
function audioRoots() {
  return libraryRoots().map(({ name, fs }) => ({ fs, url: name }));
}

/** True when `name` is a direct, non-hidden content-root folder. Decided by
 *  what exists on disk, NOT by a name pattern: library folders may contain
 *  spaces or non-ASCII characters (e.g. "Seek Girl III", "Black Market",
 *  Japanese titles), and every direct folder must be reachable. Traversal is
 *  still blocked by the containment check at the call site. */
function isLibraryRoot(name) {
  if (!name || name.startsWith(".")) return false;
  return libraryRoots().some((r) => r.name === name);
}

const AUDIO_EXTS = [".wav", ".mp3", ".ogg", ".m4a"];
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const BASE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]*$/;

/** Resolve a URL-ish folder like "assets/c010" to an absolute FS dir that is
 *  inside one of the content tabs. Returns null when invalid. */
function resolveAudioDir(urlFolder) {
  const norm = String(urlFolder || "").replace(/^\/+/, "").replace(/\/+$/, "");
  for (const root of audioRoots()) {
    if (norm === root.url || norm.startsWith(root.url + "/")) {
      const fsDir = join(root.fs, norm.slice(root.url.length).replace(/^\/+/, ""));
      const resolved = normalize(fsDir);
      if (resolved === root.fs || resolved.startsWith(root.fs + sep)) return fsDir;
    }
  }
  return null;
}

/** Read the raw request body (capped). */
function readBody(req, cap = MAX_AUDIO_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Find the next free audio file name: base.ext, base_01.ext, base_02.ext… */
async function nextAudioName(fsDir, base, ext) {
  const candidate = join(fsDir, `${base}${ext}`);
  try {
    await stat(candidate);
  } catch {
    return { fsPath: candidate, name: `${base}${ext}` };
  }
  for (let n = 1; n < 1000; n++) {
    const name = `${base}_${String(n).padStart(2, "0")}${ext}`;
    try {
      await stat(join(fsDir, name));
    } catch {
      return { fsPath: join(fsDir, name), name };
    }
  }
  throw new Error("no free audio name found");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".skel": "application/octet-stream",
  ".atlas": "text/plain; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".model3.json": "application/json; charset=utf-8",
  ".motion3.json": "application/json; charset=utf-8",
  ".physics3.json": "application/json; charset=utf-8",
  ".pose3.json": "application/json; charset=utf-8",
  ".exp3.json": "application/json; charset=utf-8",
  ".userdata3.json": "application/json; charset=utf-8",
  ".cdi3.json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    // Custom audio upload: writes the request body into the asset's folder
    // with the asset's base name, appending _01, _02… when the name is taken.
    if (pathname === "/api/audio" && req.method === "POST") {
      const folder = resolveAudioDir(url.searchParams.get("folder") || "");
      const base = String(url.searchParams.get("base") || "");
      const ext = String(url.searchParams.get("ext") || "").toLowerCase();
      if (!folder || !BASE_NAME_RE.test(base) || !AUDIO_EXTS.includes(ext)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "invalid folder/base/ext" })
        );
        return;
      }
      const body = await readBody(req);
      if (!body.length) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "empty body" })
        );
        return;
      }
      const { fsPath, name } = await nextAudioName(folder, base, ext);
      await writeFile(fsPath, body);
      const rel = `${url.searchParams.get("folder").replace(/^\/+|\/+$/g, "")}/${name}`;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: rel, name }));
      return;
    }

    // Custom audio delete: removes a file from an asset folder.
    if (pathname === "/api/audio" && req.method === "DELETE") {
      const target = String(url.searchParams.get("path") || "").replace(/^\/+/, "");
      const folder = resolveAudioDir(target.split("/").slice(0, -1).join("/"));
      const name = target.split("/").pop() || "";
      if (!folder || !AUDIO_EXTS.includes(extname(name).toLowerCase())) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "invalid path" })
        );
        return;
      }
      const fsPath = normalize(join(folder, name));
      if (!fsPath.startsWith(folder + sep)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "invalid path" })
        );
        return;
      }
      try {
        await unlink(fsPath);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "not found" })
        );
      }
      return;
    }

    // Dynamic character manifest: scan the content root's top-level folders
    // (the picker tabs) on every request so newly added folders appear
    // without regenerating anything.
    if (pathname === "/api/manifest") {
      const { characters, warnings } = scanContentRoot(CONTENT_DIR);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ characters, warnings }));
      return;
    }

    // Content root: report the current library folder (GET) or point it at
    // another folder (POST { dir }; empty/absent resets to the default). This
    // is what the picker's content-folder control drives.
    if (pathname === "/api/content") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ dir: CONTENT_DIR, defaultDir: defaultContentDir() }));
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readBody(req, 8 * 1024);
          const payload = JSON.parse(body.toString("utf8") || "{}");
          const target = resolveLibraryDir(payload.dir);
          if (!target) {
            res.writeHead(400, { "Content-Type": "application/json" }).end(
              JSON.stringify({ error: `not a folder: ${String(payload.dir ?? "").trim() || "(empty)"}` })
            );
            return;
          }
          CONTENT_DIR = target;
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, dir: CONTENT_DIR, defaultDir: defaultContentDir() }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: `cannot change content folder: ${err.message}` })
          );
        }
        return;
      }
    }

    // Export: POST { name, scene, bgFile? } — writes a complete, self-
    // contained interactive wallpaper folder usable by Wallpaper Engine and
    // Octos (+ a ready .zip for Octos) under the export root (exports/ by
    // default; override with LWPG_EXPORTS). The package is copied from the
    // CURRENT content root (a runtime-switched library exports as-is).
    if (pathname === "/api/export" && req.method === "POST") {
      const MAX_EXPORT_BYTES = 120 * 1024 * 1024;
      try {
        const body = await readBody(req, MAX_EXPORT_BYTES);
        const payload = JSON.parse(body.toString("utf8"));
        const scene = payload.scene;
        const name = String(payload.name || "scene");
        if (!scene || !Array.isArray(scene.sprites)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "a scene with a sprites array is required" })
          );
          return;
        }
        let bgFile = null;
        if (payload.bgFile && typeof payload.bgFile.data === "string") {
          bgFile = {
            ext: String(payload.bgFile.ext || "png").replace(/^\./, ""),
            video: !!payload.bgFile.video,
            data: Buffer.from(payload.bgFile.data, "base64"),
          };
        }
        const report = await buildPackage({ name, scene, bgFile, contentDir: CONTENT_DIR });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            ...report,
            displayPath: report.path,
          })
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: `export failed: ${err.message}` })
        );
      }
      return;
    }

    // Open an exported package's folder in the OS file manager (best effort).
    if (pathname === "/api/export/open" && req.method === "POST") {
      const body = await readBody(req, 64 * 1024);
      try {
        const payload = JSON.parse(body.toString("utf8"));
        const name = String(payload.name || "");
        const base = normalize(exportRootDir());
        const target = normalize(join(base, name));
        if (!name || !target.startsWith(base + sep)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "invalid export name" })
          );
          return;
        }
        if (!existsSync(target)) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "export folder not found" })
          );
          return;
        }
        openInFileManager(target);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: err.message })
        );
      }
      return;
    }

    // Resolve inside ROOT only (no path traversal). Any direct folder of the
    // content root is aliased from its name to <content>/<name>/, so every
    // picker tab's assets are served under a stable URL prefix (/assets/…,
    // /custom_assets/…, /live2d/… and anything the user adds later).
    let fsPath;
    // The Cubism runtime is referenced via the relative cubism/ path (matching
    // the exported package layout); in the repo it lives under vendor/cubism.
    if (pathname === "/cubism" || pathname.startsWith("/cubism/")) {
      fsPath = normalize(join(ROOT, "vendor", "cubism", pathname.slice("/cubism/".length)));
      const cubismRoot = join(ROOT, "vendor", "cubism");
      if (fsPath !== cubismRoot && !fsPath.startsWith(cubismRoot + sep)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
    } else {
      const firstSlash = pathname.indexOf("/", 1);
      const prefix = pathname.slice(1, firstSlash === -1 ? undefined : firstSlash);
      if (pathname !== "/" && isLibraryRoot(prefix)) {
        const contentRoot = join(CONTENT_DIR, prefix);
        const rel = firstSlash === -1 ? "" : pathname.slice(firstSlash + 1);
        fsPath = normalize(join(contentRoot, rel));
        if (fsPath !== contentRoot && !fsPath.startsWith(contentRoot + sep)) {
          res.writeHead(403).end("Forbidden");
          return;
        }
      } else {
        fsPath = normalize(join(ROOT, pathname));
        if (!fsPath.startsWith(ROOT) && !fsPath.startsWith(ROOT.replace(/\/$/, ""))) {
          res.writeHead(403).end("Forbidden");
          return;
        }
      }
    }

    let target = fsPath;
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = join(target, "index.html");
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end(`404 Not Found: ${pathname}`);
      return;
    }

    const data = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`500 Internal Server Error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Spinal Board dev server: http://127.0.0.1:${PORT}/`);
  console.log(`Content root: ${CONTENT_DIR}`);
});
