# Spinal Board

Build custom animated desktop wallpapers from **your own** characters and media, then export one
self-contained interactive wallpaper that runs in **Lively Wallpaper**, **Octos** and **Wallpaper Engine**.

Compose Spine skeletons plus images/GIFs/videos on a stage, give each element its animation, click/hold
reaction and audio, and export an **offline, interactive** wallpaper folder — the scene is baked in, so it
works with no account, network or extra files.

> This is a creator tool for your own assets. **No artwork ships with it** — everything you see in the app
> comes from folders you provide.

---

## Install & run

- **Windows app** — run the installer (`Spinal-Board-Setup-*.exe`). On first launch it creates
  `Documents\SpinalBoard\` with a `content` folder ready for your library.
- **From source** — Node.js 20+, then:

  ```bash
  npm install
  npm run electron     # opens the editor window (the app)
  # or: npm run serve  # browser version at http://127.0.0.1:8080
  ```

---

## Your content library

The app reads all characters/assets from a **content folder**. It shows one **tab per folder**:

```
Documents\SpinalBoard\content\     (source builds: ./content)
├── characters\        → "Characters" tab
├── media\             → "Media" tab
└── live2d\            → "Live2D" tab (experimental — see Notes)
```

Rules in short:

- **One folder inside the content folder = one picker tab** (named after the folder).
- **A character = a folder holding its own skeleton**, e.g. a Spine character `c312` containing
  `c312_00.skel` + `c312_00.atlas` + its textures. Subfolders like `aim\` or `cover\` holding
  `<name>_<variant>_00.skel` become extra variants.
- **Images / GIFs / videos** (PNG/JPEG/WebP/GIF, WebM/MP4): each file is one item. Put them in folders
  with **no skeleton** — files sitting next to a skeleton are treated as that skeleton's textures.
- **Audio** (WAV/MP3/OGG/M4A) placed next to a character (`<name>_00.wav`, `_01`, …) becomes that
  element's selectable voice lines.

**Using a different library?** Open **＋ Add character → Library folder…**, paste the path of another
folder whose subfolders hold assets, and press **Use folder** — the app remembers your choice for the
next launch. *(Advanced: launch with `LWPG_CONTENT` / `LWPG_EXPORTS` to override the default folders.)*

---

## Making a wallpaper

1. **＋ Add character** (top left) → pick characters/assets from the tabs. Repeat up to 30 elements.
2. **Click an element on the stage** → the right panel edits it: variant & animation, click/hold
   animation, audio, scale/opacity/colour/mirror, layer.
3. **Edit mode** (top bar) drags/resizes elements on the stage; **Scenes** saves several arrangements;
   **Guides** overlays your monitor ratio (16:9, 21:9, …).
4. **Preview** (`F`, `Esc` to leave), then hit **Export**.

## Export

**Export** writes the wallpaper to `Documents\SpinalBoard\exports\<scene name>\` and a ready
`<scene name>.zip` next to it (**Open folder** reveals it). The exported package is fully static and
offline:

```
<scene name>\
├── index.html      ← entry (scene baked in)
├── wallpaper.js, style.css
├── assets\ …       only the files your scene references
├── audio\ …
└── runtime\ …      Spine runtimes (with their licenses) when used
```

Keep the folder (or the `.zip`) intact — `index.html` loads the files next to it, so don't move single
files out.

---

## Using it with Lively Wallpaper

Spinal Board exports **don't include a `LivelyInfo.json`** on purpose: Lively writes its own when you add
the wallpaper, so importing is just a normal "add wallpaper":

1. **Export** your scene (above) and note the output folder or `.zip`.
2. **Add it to Lively** — either way works:
   - click **＋ (Add wallpaper)** at the top of Lively's wallpaper grid, then **browse** and select the
     exported `.zip` (or open the folder and pick `index.html`), **or**
   - simply **drag & drop** the exported folder or `.zip` onto Lively's window.
3. Lively imports a copy into its own library and **creates `LivelyInfo.json` itself** (Web wallpaper,
   entry `index.html`). If it asks for a type or entry file, choose **Web / Webpage (`index.html`)** —
   name and description are optional.
4. Click the wallpaper thumbnail to run it on your desktop.

**Interacting with the wallpaper**

- **Click or hold** a character to trigger its reaction/voice (mouse input is enabled by default in
  Lively).
- Lively's volume control sets overall sound; if you can't hear the element's audio, check the Lively
  volume and that the element isn't muted in the editor.
- If clicks stop responding, enable **Lively settings → Wallpaper → Interaction → Wallpaper Input →
  Mouse** (keyboard input is not used by this export).

**Troubleshooting**

- *Wallpaper is black / empty:* delete the entry in Lively and re-import the original `.zip` (keep the
  `.zip` or folder intact — don't import a half-moved folder).
- *No click reaction:* make sure the element has a **Click** animation selected in the editor, and that
  Lively's wallpaper input (mouse) is on.
- *Audio doesn't play:* check Lively volume and the element's audio settings (a cleared snippet or muted
  element plays nothing).

## Other wallpaper apps (brief)

- **Octos** — import the exported `<scene name>.zip`.
- **Wallpaper Engine** — add the exported folder; its `project.json` describes the `index.html` web
  wallpaper.

---

## Notes

- Exported wallpapers run fully offline and never phone home; exports contain **only the files your
  scene references**, and Spine runtimes travel with their license files.
- **Live2D/Cubism is experimental and not fully supported.** Without a separately licensed Cubism
  runtime placed in the right folder, Live2D models will not animate; exports never include Cubism files.
- Content stays on your machine — nothing is uploaded or redistributed.
