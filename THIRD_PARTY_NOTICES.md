# Third-party notices

The Live Wallpaper Generator (Spinal Board) ships **code only**. It never ships
game/character content or proprietary runtimes (see `.gitignore` — `content/`,
`vendor/cubism/` contents, `dist/`, `release/` and `.pw-browsers/` are never
committed).

## Runtime dependencies bundled into the app / exported wallpapers

| Component | Role | License | Where it lives |
| --------- | ---- | ------- | -------------- |
| [esbuild](https://esbuild.github.io/) | bundling (dev-time) | MIT | dev dependency |
| [Electron](https://www.electronjs.org/) | desktop app shell (V1 Windows app) | MIT (Electron); its bundled Chromium/Node/V8 components carry their own permissive licenses (BSD/MIT-style) | dev dependency; the installed app IS an Electron app (NSIS package) |
| [Spine Runtimes](http://esotericsoftware.com/) `spine-webgl` 4.0.31 + 4.1.56 | Spine .skel decoding/rendering | Spine Runtime License (free use incl. commercial apps; redistribution requires keeping the license notice) | vendored under `vendor/spine-4.0.31/`, `vendor/spine-4.1.56/`; each has its own `LICENSE`. **Exported wallpaper packages copy these runtimes into `runtime/` together with their `LICENSE.txt` files.** |
| [gifuct-js](https://github.com/matt-way/gifuct-js) | animated GIF decoding | MIT | npm dependency, bundled |
| [wavesurfer.js](https://wavesurferjs.org/) | audio waveform UI (editor only) | BSD-3-Clause | npm dependency, editor bundle only |
| [Playwright](https://playwright.dev/) | e2e tests (dev-time) | Apache-2.0 | dev dependency |
| [electron-builder](https://www.electron.build/) | NSIS packaging (dev-time) | MIT | dev dependency |

## Explicitly never shipped

- **Live2D/Cubism SDK for Web** (`vendor/cubism/`): licensed, user-provided.
  Cubism Framework sources are under the Live2D Open Software License and the
  Core under the Live2D Proprietary Software License — both are user-local,
  git-ignored, never bundled, and never copied into exports. Exported packages
  ship an empty `cubism/` folder with instructions. Live2D is not a supported
  feature of this project.
- **User content** (`content/`): all Spine/Live2D/media/audio assets are
  user-local. Exports copy only the referenced files.
- No other third-party binaries or asset packs are distributed.
