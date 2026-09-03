#!/usr/bin/env node
/**
 * esbuild configuration for the three bundled targets:
 *
 *   editor            — the generator UI (entry: src/main.js, loaded by index.html)
 *   template          — the DEV/live wallpaper runtime (wallpaper.html in the
 *                       repo; URL-override / saved-scene modes)
 *   template-static   — the STATIC runtime shipped inside every exported
 *                       package (entry: src/export-wallpaper.js; loads only
 *                       the baked #lwpg-scene — no manifest, no storage)
 *
 * Shared rules:
 *   - platform "browser", format "esm", target es2022 (top-level await)
 *   - the vendored Spine runtimes (vendor/spine-*) are intentionally NOT
 *     imported by these entries; they load as classic scripts before the
 *     module (see index.html / wallpaper.html). Cubism is NEVER bundled.
 *
 * Usage:
 *   node esbuild.config.mjs            # build all targets once into dist/
 *   node esbuild.config.mjs --target=editor
 *   node esbuild.config.mjs --watch    # rebuild on change (dev)
 */
import { build, context } from "esbuild";

const TARGETS = {
  editor: {
    entryPoints: ["src/main.js"],
    outfile: "dist/editor/editor.js",
  },
  template: {
    // Dev/live wallpaper runtime (wallpaper.html in the repo): URL-override /
    // saved-scene modes. NOT what exports ship.
    entryPoints: ["src/wallpaper.js"],
    outfile: "dist/template/wallpaper.js",
  },
  "template-static": {
    // Static runtime for EXPORTED packages: loads only the baked #lwpg-scene
    // JSON — no manifest import, no localStorage/IndexedDB/URL-override code.
    entryPoints: ["src/export-wallpaper.js"],
    outfile: "dist/template-static/wallpaper.js",
  },
};

const which = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "all";
const watch = process.argv.includes("--watch");
const names = which === "all" ? Object.keys(TARGETS) : [which];

const options = (name) => {
  const t = TARGETS[name];
  return {
    entryPoints: t.entryPoints,
    outfile: t.outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    legalComments: "eof",
    logLevel: "info",
  };
};

for (const name of names) {
  if (!TARGETS[name]) {
    console.error(`Unknown target "${name}" (expected one of: ${Object.keys(TARGETS).join(", ")}, all)`);
    process.exit(1);
  }
  if (watch) {
    const ctx = await context(options(name));
    await ctx.watch();
    console.log(`Watching ${name} → ${TARGETS[name].outfile}`);
  } else {
    await build(options(name));
    console.log(`Built ${name}: ${TARGETS[name].outfile}`);
  }
}
