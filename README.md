# Spinal Board — Live Wallpaper Creator

A local web app that composes a **live wallpaper scene** from mixed animated
assets — Spine, plain media, and (experimentally) Live2D/Cubism models — and
exports one **self-contained interactive wallpaper folder** that works in
**Wallpaper Engine**, **Lively** and **Octos** (plus a ready `.zip` for Octos).
The exported package runs fully **offline and statically**: the scene is baked
in, with no localStorage, IndexedDB, dynamic manifest, or network access.

**Status:** **V1 shipped.** The proven web engine is complete (phases 0–4
below), and the V1 desktop deployment is in place: **absolute-path export
roots**, a **three-manager combined export** (`index.html` entry +
`project.json` + `LivelyInfo.json` + `octos.json` + `.zip`), an **Electron
desktop shell** (bundles the zero-dependency Node server inside Electron and
opens the editor) and an **electron-builder NSIS Windows installer**
(`npm run dist:win`, to run on Windows 10/11). Video export, thumbnails, code
signing and auto-update are **deferred out of V1** (see
[V1_PLAN.md](V1_PLAN.md), a local review note).

## Live2D / Cubism — NOT an officially supported feature

**Live2D is experimental and unsupported in this project — for Cubism 3/4/5
and Cubism 2 alike.** The repository ships code only, and no assets or
proprietary runtimes are part of it or are ever committed, bundled, or
redistributed (see `.gitignore` and "Cubism — hard constraint" below).

- An experimental adapter in the code can render Cubism 3/4/5
  (`.model3.json`) models *only* when the user supplies both the licensed
  Cubism runtime (dropped under `vendor/cubism/Core/`) and the model files
  themselves. Without either it degrades gracefully. No guarantees are made
  about correctness, coverage of model features, or maintenance.
- **Cubism 2** assets (`model.json` + `model.moc` + `motions/*.mtn` +
  `textures/*.png`) are **not supported at all** — the licensed Cubism SDK for
  Web cannot load them. The library scanner recognizes Cubism 2 model folders
  generically and shows each as a clearly-labelled "cubism 2" picker card that
  cannot be added to a scene; their textures are never listed as standalone
  media.
- Live2D support is **not part of the acceptance criteria** and is **not
  covered by the automated test suite**. The export pipeline never includes
  Cubism files, and the exported wallpaper never depends on them.

## Guiding principles

- **Robust over clever** — do the basic tasks well; don't build "Photoshop for
  wallpapers".
- **Minimal self-implementation** — use proven libraries for generic
  infrastructure; write only the glue unique to this product.
- **Performant** — one shared WebGL context, a bounded sprite cap, lazy loading.
- **Ships code only** — no game/character assets and no proprietary runtimes are
  redistributed.

## Feature matrix

| Kind   | Formats                                      | Notes                                                                    |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------ |
| Spine  | binary `.skel` and JSON, 3.7.x–4.1.x | four official runtimes (spine-webgl 3.7.94 / 3.8.95 / 4.0.31 / 4.1.56) chosen from the skeleton version header via a dispatch table (format + version sniffed from content); 4.2+ out of scope |
| Live2D | **not supported** (experimental)              | Cubism 3/4/5 (`.model3.json`) renders best-effort only with a user-supplied runtime + models; Cubism 2 (`model.json`/`.moc`/`.mtn`) is not supported and is labelled as such in the picker — see "Live2D / Cubism — NOT an officially supported feature" |
| Media  | PNG/JPEG/WebP/GIF, WebM/MP4                  | animated GIF via gifuct-js; animated WebP shows its first frame (documented limitation) |
| Audio  | user audio files                             | per-element start/end snippet, trimmed in the editor (wavesurfer.js + Regions) and played on click/hold in the editor and the exported wallpaper |

## Architecture

Three esbuild bundles share one runtime core:

- **Editor** (the generator) — full UI, preview, export (`dist/editor`).
- **Live wallpaper template** — dev/URL-override runtime for `wallpaper.html`
  in the repo (`dist/template`).
- **Static wallpaper runtime** — what exports ship: loads only the baked
  scene, no manifest/storage/network code (`dist/template-static`; bundled by
  `/api/export` as `wallpaper.js`).

Shared core: `SceneController` + `StageRenderer` behind a `SpriteAdapter`
interface, on a single shared WebGL context.

- Base: the existing engine — the dual-runtime spine-webgl shared-canvas
  renderer and the "image/GIF/video as a single-region skeleton" trick.
  **Extend, don't rewrite.**
- Adapters (`src/sprite-adapters.js`): `image` / `gif` (gifuct-js) / `video`
  (WebM/MP4) load plain assets into the shared model; `spine` loads skeletons
  via the variant entry; `live2d` (experimental, not a supported feature —
  see "Live2D / Cubism — NOT an officially supported feature") renders a
  `.model3.json` model into its own offscreen Cubism canvas and composites it
  through the same single-region texture path (so layout / drag / resize /
  mirror / tint / hit-testing are shared with every other kind). Every adapter
  produces one uniform renderable, so the stage and the editor UI need no
  per-kind code.
- **No PixiJS** — its single-runtime Spine plugin would drop Spine 4.0.x assets.
- Uniform per-sprite color (tint / brightness / RGB / opacity / mirror) stays
  `skeleton.color` for Spine/image/video/GIF; Live2D applies the same math via
  Cubism multiply-colour overrides (a Cubism colour parameter).

## Cubism — hard constraint

Cubism is **never vendored, bundled, committed, or redistributed**. It is not an
npm dependency and the app bundles never contain it. The designated folder is
`vendor/cubism/`:

```text
vendor/cubism/
├── README.md                 # "place your licensed Cubism SDK for Web here"
├── Core/
│   └── live2dcubismcore.min.js
└── Framework/
    └── live2d.min.js
```

- **Drop-in + auto-build:** unzip the Cubism SDK for Web (3/4/5) anywhere under
  `vendor/cubism/Core/` (e.g. `vendor/cubism/Core/CubismSdkForWeb-5-r.5/`) and
  run any of `npm run build` / `npm run dev` / `npm run serve` (or
  `npm run cubism` directly). `scripts/build-cubism.mjs` locates the SDK,
  flattens `Core/live2dcubismcore.min.js`, and compiles the Framework
  TypeScript into `Framework/live2d.min.js` (with its GLSL shaders embedded, so
  the result is self-contained and runs offline). The two outputs are
  git-ignored, never committed, and never shipped.
- `Live2DAdapter` dynamically injects Core + Framework from the relative
  `cubism/` path at first use, then verifies the runtime globals
  (`Live2DCubismCore`, `Live2DCubismFramework`).
- **Graceful degradation:** without the runtime, the editor still lists
  `.model3.json` models but shows an install hint; the exported wallpaper still
  runs all other sprite kinds and shows a non-fatal placeholder for Live2D
  sprites.

## Export

Each export produces **one combined folder** (usable by all three managers) plus
a ready `.zip` of it (Octos installs from `.zip`):

```text
<scene-name>/
├── index.html           (canonical entry — scene baked in)
├── wallpaper.js         (esbuild bundle, cubism NOT included)
├── style.css
├── project.json         (Wallpaper Engine: file = index.html)
├── LivelyInfo.json      (Lively: Type "web", FileName = index.html)
├── octos.json           (Octos: entry = index.html)
├── assets/…             (copied, referenced assets only)
├── audio/…              (copied, referenced audio only)
├── runtime/…            (vendored Spine runtimes + licenses, when used)
└── cubism/              (empty + README: user places their own Cubism)

<scene-name>.zip         (same folder contents, at the archive root — Octos)
```

- The scene is baked into the package (JSON) — the exported wallpaper has no
  localStorage, IndexedDB, dynamic manifest, or network.
- Only referenced assets are copied, never the whole content library.
- The editor's **Export** button POSTs the current scene to `/api/export`
  (dev server), which writes the folder + `.zip` under the export root
  (`exports/` by default; `LWPG_EXPORTS` override; the packaged app defaults to
  `Documents\SpinalBoard\exports`) and opens the folder in the OS file manager
  (the **Open folder** button re-opens it). The status line reports both the
  folder and that the Octos `.zip` was produced.
- The `.zip` step uses PowerShell `Compress-Archive` on Windows (zero new
  dependency; 2 GB / long-path ceiling accepted for V1). On POSIX dev/test
  machines it uses the system `zip` tool so the e2e suite can assert the
  archive.
- v1 Cubism handling is strictly manual (empty folder + instructions). An
  optional default-off "copy my local cubism" toggle is deferred unless it's
  clearly the user's own licensed files with an explicit redistribution warning.

## Content discovery & library layout

No assets ship with the project. The generator scans a user-configured content
root (default `content/`, override with `LWPG_CONTENT`) for Spine skeletons
(binary `.skel` + `.atlas`, or JSON `<name>.json` + `.atlas`), Live2D models
(`.model3.json`), images, GIFs, videos and audio. The dev server's
`/api/manifest` rescans on every request; the bundled
`src/manifest.js` is only the static-deployment fallback. Editor thumbnails
render progressively on demand.

The picker's tabs and subtabs are **derived from the folders**, never
hard-coded:

```text
content/                      # the content root
├── assets/                   # → picker TAB "Assets"
│   ├── c312/                 #   a folder holding its own asset = ONE item
│   │   ├── c312_00.skel      #     variant "normal"
│   │   ├── c312_00.png       #     texture for the .atlas (ignored as an item)
│   │   ├── aim/c312_aim_00…  #     subfolder variant "aim"
│   │   └── cover/c312_cover… #     subfolder variant "cover"
│   └── c313/
├── custom_assets/            # → picker TAB "Custom Assets"
│   ├── samples/              #   any other direct subfolder = SUBTAB "Samples"
│   │   ├── sample.png        #   media items (no .skel in this folder)
│   │   ├── sample.gif
│   │   └── sample.webm
│   └── Nikke/                #   SUBTAB "Nikke" (folders inside fold up)
│       └── c010/c010_00.skel #     one item per character, variants from aim/cover
└── live2d/                   # → picker TAB "Live2D"
    └── Haru/Haru.model3.json #   a folder holding a model = ONE item
```

Where to put folders (rules):

- **One TAB per folder directly inside the content root.** Put a folder at
  `content/` root level for every tab you want: e.g. `content/characters/`,
  `content/media/`, `content/bd2/`. Everything else is nested inside those.
- **A Spine character = a folder containing `<folder-name>_00.skel`** (+ its
  `.atlas` and textures in the same folder). It becomes ONE picker item with a
  "normal" variant; subfolders named like the variant (`aim/`, `cover/`) that
  hold `<folder-name>_<variant>_00.skel` become that item's variants.
- **JSON skeletons work too.** A folder holding `<name>.json` + `<name>.atlas`
  (Spine's JSON export, common in game rips) is a character the same way, and
  JSON skeletons shipped misnamed as `.skel` are detected by content sniffing
  — the version header (3.7.x / 3.8.x / 4.0.x / 4.1.x) picks the matching
  bundled runtime, exactly like binary skeletons.
- **Flat/loose skeletons** (`whatever.skel` or `whatever.json` + its `.atlas`)
  work too — each pair becomes its own item wherever it sits (e.g. a
  "costumes" folder with one pair per costume). Their texture pages can sit
  next to them.
- **A Live2D model = a folder containing a `.model3.json`** → one item; the
  model's own subfolders (motions/expressions/textures/…) are resources.
- **Standalone media** (images/GIFs/videos): each file is one item. Put them
  in folders that contain **no skeletons** (no `.skel`, no Spine JSON pair) —
  any image/video next to a skeleton is treated as that skeleton's texture and
  is NOT listed, so a skeleton's `name.png`, `name_2.png`, … pages never
  clutter the picker.
- **Subtabs**: a tab's direct subfolders that aren't themselves single assets
  become its subtab list; anything deeper folds up into that subtab (there is
  exactly one subtab level). Want `character`/`interaction`/`cutscene` as
  separate subtabs of a catalogue? Put the catalogue's categories as siblings:
  `content/custom_assets/character/`, `content/custom_assets/interaction/`, …
  (or `content/cat/character/…` only gives you one "Cat" subtab).
- Items sitting directly in a tab folder appear at tab level (under a trailing
  "Misc" subtab only when the tab also has real subtabs).
- Per-asset audio (`<base>.wav/.mp3/.ogg/.m4a`, `_01`, `_02`, … next to the
  asset) is attached to its item for the audio/snippet features.
- Hidden folders (starting with `.`) are ignored.

Dropping in a new folder — or deleting one — changes the picker on the next
load with no code or manifest change; the same rules apply to every folder
(the old catalogue-specific `bd2_assets`/source/type semantics are gone).

## Data model (single JSON scene)

```text
Scene  { id, name, background{color|image|video}, layers[], sprites[], volume }
Sprite { id, type: spine|live2d|image|video|gif,
         assetRef, variant, animation, click, speed, loop, paused,
         layout{x,y,scale,fw,fh}, color{tint,brightness,r,g,b,opacity},
         mirror, layer, audio{file, start, end, mute} }
```

## Dependencies (final, bounded list)

| Library                     | Role                                   | Replaces / avoids                        |
| --------------------------- | -------------------------------------- | ---------------------------------------- |
| esbuild                     | bundle editor + template               | hand-vendored runtime globals            |
| spine-webgl 4.0.31 + 4.1.56 | Spine runtimes (kept)                  | —                                        |
| Cubism SDK for Web          | Live2D runtime                         | user-provided, never shipped             |
| gifuct-js                   | GIF decode                             | new capability                           |
| wavesurfer.js + Regions     | audio snippet UI (editor only)         | new capability                           |
| playwright                  | e2e                                    | replaces the retired WebDriver-BiDi harness |
| Node http server (extended) | dev server + `/api/export`             | keep existing server                     |
| Electron                    | V1 desktop shell (runs the server above as Electron's own Node) | separate Node install / system tray glue |
| electron-builder            | Windows NSIS packaging (dev-time)      | manual installer tooling                  |

Explicitly **not** used: PixiJS (drops Spine 4.0.x), any UI framework (vanilla
UI + snippet/export panels), Express/sirv, localforage/idb-keyval.

## Performance budget

- One shared WebGL context; ≤ 30 sprites.
- DPR-aware sizing; pause the render loop when the tab is hidden.
- Lazy thumbnails; export copies only referenced assets.

## Testing

- Playwright e2e (`npm test`, Chromium cached under `.pw-browsers`, its own
  dev server on 8092): editor basics, keyboard shortcuts/preview, persistence,
  scenes/layers CRUD, audio upload + snippet playback, playback semantics
  (variants/click-hold), editing (drag/resize/mirror/backgrounds/guides),
  stage layout + 30-sprite cap + animation probes, **export** (the combined
  folder now contains `index.html`, `project.json`, `LivelyInfo.json`,
  `octos.json` and the `.zip`; the exported folder is then loaded as a fully
  static wallpaper and rendered), and **missing-Cubism degradation** (the app
  must not depend on the Live2D runtime). Specs drive the app via its
  automation handles (`window.__spineViewer`, `window.__lwpg`). The former
  WebDriver-BiDi harness has been retired.
- **Desktop smoke test** (`tests/e2e/desktop.spec.js`): launches the Electron
  shell and asserts the editor window loads. Skipped unless `RUN_ELECTRON=1`
  is set (it needs a display / Windows or a headless X server) — full
  NSIS/installer testing stays manual on Windows. On POSIX CI boxes with a
  read-only `$HOME`, point `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` at a writable
  dir (Chromium's profile) and set `LWPG_ELECTRON_NO_SANDBOX=1` in containers.
- Live2D rendering is **not supported** (experimental only, user-supplied
  runtime + models) and is outside the automated and acceptance test scope;
  Playwright asserts the app works with the Cubism runtime absent.

## Roadmap (implementation phases)

| Phase | Scope                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------- |
| 0     | **Scaffold** ✅                                              |
| 1     | **Runtime core** ✅                                          |
| 2     | **Audio snippets** ✅                                        |
| 3     | **Export** ✅ (folder package + baked scene + `/api/export` + open folder) |
| 4     | **Tests** ✅ (Playwright suite replaces the WebDriver-BiDi harness; export, missing-Cubism degradation, snippets, stage/cap/scenes covered) |
| 5     | **Docs & cleanup** ✅ (asset-layout docs, licensing notices, remove obsolete URL-param/IndexedDB/dynamic-manifest paths from the output) |
| V1.0   | **Multi-target interactive export** ✅ (`index.html` entry + `project.json` + `LivelyInfo.json` + `octos.json` + Octos `.zip`; absolute `LWPG_*` roots) |
| V1.1   | **Electron desktop shell** ✅ (server bundled via Electron's own Node, port fallback, `Documents\SpinalBoard\{content,exports}` defaults, single instance) |
| V1.2   | **Windows packaging** ✅ (electron-builder NSIS; `content`/`exports` kept outside `app.asar`; no signing/auto-update) |

## Acceptance criteria

1. Import and render Spine 3.7.x–4.1.x (binary `.skel` and JSON), image, video,
   and GIF sprites.
2. Live2D is **not** a supported feature; its experimental code never ships or
   bundles a runtime, degrades cleanly when content/runtime is absent, and is
   excluded from acceptance. Legacy Cubism 2 folders are recognized but shown
   as unsupported, never rendered.
3. Select a start/end audio snippet per element and hear it on click/hold in both
   editor and export.
4. Export a folder that runs offline in **Wallpaper Engine, Lively and Octos**
   with the scene baked in (`index.html` + the three metadata files + a `.zip`).
5. The export contains no Cubism files and no third-party game assets.
6. All automated tests pass; exported-package render produces a non-empty pixel
   signature.
7. (V1 desktop) `npm run electron` opens the working editor in an Electron
   window; audio upload, scene save and export all function there; the packaged
   app writes only under `Documents\SpinalBoard\…` (never the install dir).
8. (V1 desktop) The NSIS installer builds on Windows 10/11 (`npm run dist:win`);
   the installed app runs and exports. Manual acceptance on Windows.

## Locked decisions (record)

- **Shell:** local web app **+ Electron desktop wrapper (V1)** · **Runtime:**
  reuse current engine as the template · **Output:** one combined folder for
  Wallpaper Engine + Lively + Octos, **plus** an Octos `.zip`.
- **Electron:** bundle the zero-dependency Node dev server, run it as a child
  with `ELECTRON_RUN_AS_NODE=1` + `process.execPath`; `dist/`, `vendor/spine-*`
  and the HTML/CSS ride inside `app.asar`; `content/` + `exports/` stay outside
  (default `Documents\SpinalBoard\…`, overridable with `LWPG_*`).
- **Cubism:** `vendor/cubism/`, user-provided, never shipped · **Spine:** 3.7.x +
  3.8.x (JSON/binary via GitHub-tagged runtimes) + 4.0.x + 4.1.x (npm runtimes);
  four namespaced runtimes dispatched by version header · **UI:** vanilla.
- **Deferred out of V1:** looping **video export**, thumbnails/previews, code
  signing + auto-update, multi-monitor export (managers place one wallpaper per
  monitor).
- **Non-goals:** undo/redo, timelines, Cubism 2, background audio,
  multi-snippet playlists.

## Development

Requires Node.js ≥ 20. Dependencies install once: `npm install` (an in-workspace
npm cache is used automatically when the default cache is unwritable).

```bash
npm install        # once (in-workspace npm cache used when needed)
npm run build      # esbuild bundles (editor + template + template-static) into dist/ — REQUIRED before serve
npm run dev        # esbuild watch mode (auto-rebuild while you edit)
npm run serve      # dev server on http://127.0.0.1:8080/ (content root: ./content)
npm run electron   # run the V1 desktop shell (Electron) on the repo content library
npm run manifest   # regenerate the bundled fallback src/manifest.js
npm test           # Playwright suite (browsers auto-installed into .pw-browsers via npx playwright install chromium)
npm run dist:win   # build the Windows NSIS installer — run ON WINDOWS (see below)
```

The app loads esbuild bundles (`dist/editor/editor.js`, `dist/template/
wallpaper.js`) — after changing `src/` either run `npm run build` or keep
`npm run dev` (watch) running. The vendored Spine runtimes still load as
classic scripts; Cubism is never bundled. `npm test` starts its own dev
server on port 8092 automatically.

**Content layout:** the library lives under the content root (default
`content/`, override with `LWPG_CONTENT`). Every direct folder under it
becomes a picker tab (see "Content discovery & library layout" above); the
repo ships a small fixture set under `content/` for development/testing only —
it is git-ignored and never redistributed. The Playwright specs require the
two Spine dev fixtures (`content/assets/c312` and `content/assets/c313`).

**Absolute roots:** `LWPG_CONTENT` / `LWPG_EXPORTS` may be **absolute paths**
(e.g. `LWPG_CONTENT="D:\Library" npm run serve`) — an absolute value is used
verbatim, never joined onto the repo root.

## Desktop app (Electron) & Windows installer

The V1 desktop shell bundles the same zero-dependency dev server **inside
Electron** — the server runs as a child process with
`ELECTRON_RUN_AS_NODE=1` + `process.execPath` (Electron's own Node), so its
fs reads the packaged `dist/`, `vendor/spine-*`, `index.html`, … straight out
of `app.asar`. No preload/IPC exists: audio upload, scene save and export all
keep using the HTTP endpoints, and **Open folder** works through the server's
`cmd /c start` call. Port 8080 is preferred and the next free port is used
when busy; a single instance is enforced.

**Where the app keeps files (packaged):** the install dir is never written to.
On first run the app creates:

```text
Documents\SpinalBoard\
├── content\     # drop your library folders here (each direct folder = a tab)
└── exports\     # exported folders + .zip land here
```

Both are overridable at launch with the `LWPG_CONTENT` / `LWPG_EXPORTS` env
vars. In dev (`npm run electron`, unpackaged) the repo `content/` / `exports/`
are used unless the env vars are set — convenient for working on the real
library.

**Build the installer (do this on Windows 10/11):**

```bash
npm run dist:win       # esbuild bundles run automatically first, then electron-builder → NSIS under release/
```

`npm run dist:win` now auto-runs the esbuild bundles before packaging — the
packaged app.asar always contains `dist/` (a missing `dist/` used to produce a
silently broken installer whose UI had no JavaScript: only native dropdowns
still responded). `electron-builder` config lives in `package.json`
(`"build"`): appId `com.spinalboard.generator`, productName **Spinal Board**,
`asar: true` with `content`/`exports` excluded from the archive, NSIS
per-user installer with a desktop shortcut. **No code signing / auto-update in
V1** (internal-only distribution): Windows SmartScreen will warn — "More info
→ Run anyway".

## Legal / licensing notes

The project ships **code only**. All content (Spine/Live2D models, media,
audio) is user-local and never redistributed; the Cubism SDK is covered by the
user's own license and must be placed into `vendor/cubism/` by the user (see
that directory's README). Exported wallpapers never include third-party runtime
or content files. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for
the exact components and licenses that are bundled or copied into exports
(e.g. the Spine runtimes, which travel with their license files).
