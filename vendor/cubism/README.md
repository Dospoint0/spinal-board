# Cubism SDK for Web — place your licensed files here

**Live2D support is strictly user-provided.** The Cubism SDK for Web is never
vendored, bundled, committed, or redistributed by this project: it is not an
npm dependency, it is not copied into exported wallpapers, and `.gitignore`
excludes everything under `Core/` and `Framework/` in this folder (only this
README and the empty folder skeleton ship with the repository).

## How to install (drop-in + auto-build)

1. Obtain the **Cubism SDK for Web** from Live2D under your own license
   (https://www.live2d.com/download/cubism-sdk/).
2. Unzip it anywhere under this folder's `Core/` subfolder, e.g.:

   ```text
   vendor/cubism/Core/CubismSdkForWeb-5-r.5/
   ├── Core/live2dcubismcore.min.js
   ├── Framework/src/…        # Cubism 5 ships the Framework as TypeScript
   └── Samples/Resources/…
   ```

3. Run any project command (`npm run build`, `npm run dev`, `npm run serve`,
   or `npm run cubism`). The project's `scripts/build-cubism.mjs` locates the
   SDK, flattens `Core/live2dcubismcore.min.js`, and compiles the Framework
   into `Framework/live2d.min.js` (shaders embedded, so it is self-contained
   and runs offline). This runs once, then reuses the compiled file.

The app injects both files from the relative `cubism/` path at first use and
verifies the `Live2DCubismCore` / `Live2DCubismFramework` globals. Without
them everything else keeps working and Live2D degrades to a non-fatal
placeholder.

To add models, drop a `.model3.json` model (with its `.moc3`, textures and
motions) anywhere under your content root — default `content/live2d/`.
