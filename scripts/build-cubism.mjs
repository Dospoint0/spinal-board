#!/usr/bin/env node
/**
 * build-cubism.mjs — turns the user's Cubism SDK for Web (dropped under
 * vendor/cubism/Core/, e.g. vendor/cubism/Core/CubismSdkForWeb-5-r.5/) into
 * the runtime files the app's Live2D loader expects:
 *
 *   vendor/cubism/Core/live2dcubismcore.min.js   (flattened copy of the Core)
 *   vendor/cubism/Framework/live2d.min.js        (compiled Framework, exposing
 *                                                 the Live2DCubismFramework
 *                                                 global like Cubism 4 did)
 *
 * Cubism 5 ships the Framework as TypeScript source, so it is compiled here
 * with esbuild. The outputs are USER-LOCAL build artifacts: they are
 * git-ignored, never committed, never shipped, and never bundled into the app
 * (the Live2D runtime loader still injects them dynamically at first use).
 *
 * Idempotent: runs automatically before build/dev/serve (npm pre-* scripts)
 * and is a no-op when the SDK is absent (Live2D then degrades gracefully) or
 * the outputs are already up to date. Use --force to rebuild.
 */
import {
  existsSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORE_DIR = join(ROOT, "vendor", "cubism", "Core");
const FW_DIR = join(ROOT, "vendor", "cubism", "Framework");
const CORE_OUT = join(CORE_DIR, "live2dcubismcore.min.js");
const FW_OUT = join(FW_DIR, "live2d.min.js");

/** Find a Cubism SDK root under vendor/cubism/Core (skips .gitkeep). */
function findSdkRoot() {
  if (!existsSync(CORE_DIR)) return null;
  for (const entry of readdirSync(CORE_DIR)) {
    if (entry === ".gitkeep" || entry.startsWith(".")) continue;
    const dir = join(CORE_DIR, entry);
    if (
      existsSync(join(dir, "Core", "live2dcubismcore.min.js")) &&
      existsSync(join(dir, "Framework", "src", "live2dcubismframework.ts"))
    ) {
      return dir;
    }
  }
  return null;
}

async function buildCubism(force = false) {
  const sdk = findSdkRoot();
  if (!sdk) {
    console.log("[cubism] SDK not found under vendor/cubism/Core — Live2D degrades gracefully.");
    return false;
  }
  const coreSrc = join(sdk, "Core", "live2dcubismcore.min.js");
  const fwEntry = join(sdk, "Framework", "src", "live2dcubismframework.ts");

  const upToDate =
    existsSync(CORE_OUT) &&
    existsSync(FW_OUT) &&
    statSync(CORE_OUT).mtimeMs >= statSync(coreSrc).mtimeMs &&
    statSync(FW_OUT).mtimeMs >= statSync(fwEntry).mtimeMs;
  if (upToDate && !force) {
    console.log("[cubism] runtime already built (--force to rebuild).");
    return true;
  }

  mkdirSync(CORE_DIR, { recursive: true });
  mkdirSync(FW_DIR, { recursive: true });
  copyFileSync(coreSrc, CORE_OUT);

  // Copy the GLSL shaders next to the compiled Framework so the runtime can
  // load them via the relative cubism/Shaders/WebGL/ path (the official
  // Cubism renderer flow, used by the SDK's own sample).
  const shaderSrcDir = join(sdk, "Framework", "Shaders", "WebGL");
  const shaderOutDir = join(ROOT, "vendor", "cubism", "Shaders", "WebGL");
  mkdirSync(shaderOutDir, { recursive: true });
  for (const f of readdirSync(shaderSrcDir)) {
    if (f.endsWith(".vert") || f.endsWith(".frag")) {
      copyFileSync(join(shaderSrcDir, f), join(shaderOutDir, f));
    }
  }

  // A tiny wrapper re-exports the Framework namespace onto globalThis so the
  // classic-script injection path and globals verification stay Cubism-4-like.
  const wrapper = join(ROOT, ".scratch", "cubism-wrapper.ts");
  mkdirSync(dirname(wrapper), { recursive: true });
  const S = (p) => JSON.stringify(join(sdk, "Framework", "src", p));
  // Cubism 5's renderer loads its GLSL shaders from files by default; embed
  // them into the bundle so the compiled live2d.min.js is self-contained and
  // runs offline (and no Cubism shader files ever need to ship).
  const shaderProps = [
    ["_vertShaderSrc", "vertshadersrc.vert"],
    ["_vertShaderSrcMasked", "vertshadersrcmasked.vert"],
    ["_vertShaderSrcSetupMask", "vertshadersrcsetupmask.vert"],
    ["_fragShaderSrcSetupMask", "fragshadersrcsetupmask.frag"],
    ["_fragShaderSrcPremultipliedAlpha", "fragshadersrcpremultipliedalpha.frag"],
    ["_fragShaderSrcMaskPremultipliedAlpha", "fragshadersrcmaskpremultipliedalpha.frag"],
    ["_fragShaderSrcMaskInvertedPremultipliedAlpha", "fragshadersrcmaskinvertedpremultipliedalpha.frag"],
    ["_vertShaderSrcCopy", "vertshadersrccopy.vert"],
    ["_fragShaderSrcCopy", "fragshadersrccopy.frag"],
    ["_fragShaderSrcColorBlend", "fragshadersrccolorblend.frag"],
    ["_fragShaderSrcAlphaBlend", "fragshadersrcalphablend.frag"],
    ["_vertShaderSrcBlend", "vertshadersrcblend.vert"],
    ["_fragShaderSrcBlend", "fragshadersrcpremultipliedalphablend.frag"],
  ];
  const shaders = {};
  for (const [prop, file] of shaderProps) {
    shaders[prop] = readFileSync(join(sdk, "Framework", "Shaders", "WebGL", file), "utf8");
  }
  writeFileSync(
    wrapper,
    [
      `import { CubismFramework, Option } from ${S("live2dcubismframework.ts")};`,
      `import { CubismUserModel } from ${S("model/cubismusermodel.ts")};`,
      `import { CubismModelSettingJson } from ${S("cubismmodelsettingjson.ts")};`,
      `import { CubismDefaultParameterId } from ${S("cubismdefaultparameterid.ts")};`,
      `import { CubismMotion } from ${S("motion/cubismmotion.ts")};`,
      `import { ACubismMotion } from ${S("motion/acubismmotion.ts")};`,
      `import { CubismMatrix44 } from ${S("math/cubismmatrix44.ts")};`,
      `import { CubismModelMatrix } from ${S("math/cubismmodelmatrix.ts")};`,
      `import { CubismViewMatrix } from ${S("math/cubismviewmatrix.ts")};`,
      `import { CubismTextureColor } from ${S("rendering/cubismrenderer.ts")};`,
      `import { CubismWebGLOffscreenManager } from ${S("rendering/cubismoffscreenmanager.ts")};`,
      `import { CubismShaderManager_WebGL, CubismShaderSet } from ${S("rendering/cubismshader_webgl.ts")};`,
      `const NS: any = { CubismFramework, Option, CubismUserModel, CubismModelSettingJson, CubismDefaultParameterId, CubismMotion, ACubismMotion, CubismMatrix44, CubismModelMatrix, CubismViewMatrix, CubismTextureColor, CubismWebGLOffscreenManager, CubismShaderManager_WebGL, CubismShaderSet };`,
      `NS.Shaders = ${JSON.stringify(shaders)};`,
      `(globalThis as any).Live2DCubismFramework = NS;`,
      `(globalThis as any).CubismFramework = CubismFramework;`,
      ``,
    ].join("\n")
  );

  await build({
    entryPoints: [wrapper],
    outfile: FW_OUT,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });

  console.log(`[cubism] compiled ${FW_OUT} (${(statSync(FW_OUT).size / 1024).toFixed(0)} KB)`);
  console.log(`[cubism] copied  ${CORE_OUT}`);
  return true;
}

const force = process.argv.includes("--force");
buildCubism(force).then(
  (ok) => process.exit(ok ? 0 : 0),
  (err) => {
    console.error("[cubism] build failed:", err.message);
    process.exit(1);
  }
);
