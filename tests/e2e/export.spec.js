/**
 * Export round-trip (V1): the editor exports the current scene via
 * /api/export; the resulting package is checked on disk — ONE combined folder
 * for Wallpaper Engine (project.json), Lively (LivelyInfo.json) and Octos
 * (octos.json) plus a ready .zip — and then LOADED and rendered as a fully
 * static wallpaper (no editor, no API, no localStorage).
 */
import { test, expect } from "playwright/test";
import { existsSync, readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootEditor, evalIn, waitTruthy, renderedPixels } from "./helpers.js";

const EXPORTS = join(process.cwd(), "exports");

function newestExport() {
  if (!existsSync(EXPORTS)) return null;
  return readdirSync(EXPORTS)
    .filter((n) => existsSync(join(EXPORTS, n, "index.html")))
    .sort((a, b) => statSync(join(EXPORTS, b)).mtimeMs - statSync(join(EXPORTS, a)).mtimeMs)[0];
}

test("exports one combined folder (WE + Lively + Octos) + .zip that plays back statically", async ({ page }) => {
  await bootEditor(page);
  // Deterministic scene: default spine sprite + an image sprite + colour bg.
  await evalIn(page, `window.__spineViewer.addSprite("samples/sample.png"); true`);
  await waitTruthy(page, `window.__spineViewer.sprites().length >= 2`);
  await evalIn(page, `(() => {
    const s = document.getElementById("background-select");
    s.value = "#123456";
    s.dispatchEvent(new Event("change"));
    return true;
  })()`);
  await page.waitForTimeout(200);

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.click("#export-btn");
  await expect
    .poll(() => evalIn(page, `document.getElementById("status").textContent`))
    .toMatch(/Exported|Export failed/);
  const status = await evalIn(page, `document.getElementById("status").textContent`);
  expect(status).toContain("Exported");
  // The status reports the folder plus the Octos .zip.
  expect(status).toMatch(/\.zip/);

  const folder = newestExport();
  expect(folder).toBeTruthy();
  const root = join(EXPORTS, folder);
  const rel = (p) => join(root, p);

  // Combined package structure: ONE canonical entry (index.html) + the three
  // managers' metadata + a ready Octos .zip next to the folder.
  for (const f of ["index.html", "wallpaper.js", "style.css", "project.json", "LivelyInfo.json", "octos.json", "cubism/README.md"]) {
    expect(existsSync(rel(f)), `${f} missing`).toBe(true);
  }
  // The old Wallpaper-Engine-only entry name is gone.
  expect(existsSync(rel("wallpaper.html")), "wallpaper.html should be renamed to index.html").toBe(false);

  // The default boot sprite is an assets skeleton — copied into assets/.
  const assetFiles = readdirSync(root).length > 0;
  expect(assetFiles).toBe(true);
  // Image sprite copied; nothing from an unreferenced tab (e.g. BD2) may leak.
  const walk = (d, acc = []) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p, acc);
      else acc.push(p);
    }
    return acc;
  };
  const files = walk(root).map((p) => p.slice(root.length + 1).split("\\").join("/"));
  expect(files.some((f) => f.endsWith("sample.png") && f.startsWith("assets/"))).toBe(true);
  expect(files.some((f) => f.includes("BD2"))).toBe(false);

  // project.json declares the web wallpaper entry = index.html.
  const project = JSON.parse(readFileSync(rel("project.json"), "utf8"));
  expect(project.file).toBe("index.html");
  expect(project.type).toBe("web");

  // LivelyInfo.json: Type "web" + FileName index.html + Title/Desc/Author
  // (field names mirror Lively's LivelyInfoModel.cs).
  const lively = JSON.parse(readFileSync(rel("LivelyInfo.json"), "utf8"));
  expect(lively.Type).toBe("web");
  expect(lively.FileName).toBe("index.html");
  expect(lively.Title).toBe(folder);
  expect(typeof lively.Desc).toBe("string");
  expect(typeof lively.Author).toBe("string");

  // octos.json: entry index.html.
  const octos = JSON.parse(readFileSync(rel("octos.json"), "utf8"));
  expect(octos.entry).toBe("index.html");
  expect(octos.name).toBe(folder);

  // The ready .zip (Octos installs from it) sits next to the folder.
  const zipPath = join(EXPORTS, `${folder}.zip`);
  expect(existsSync(zipPath), ".zip missing").toBe(true);
  expect(statSync(zipPath).size).toBeGreaterThan(0);

  // Load the exported wallpaper: fully static, renders, no page errors.
  await page.goto(`/exports/${encodeURIComponent(folder)}/index.html`);
  await page.waitForFunction(() => window.__lwpg && window.__lwpg.ready === true, undefined, { timeout: 40000 });
  const drawn = await evalIn(page, `(() => { const st = window.__lwpg.stage; st.renderOnce(); return st.canvasPixels().drawn; })()`);
  expect(drawn).toBeGreaterThan(500);
  const baked = await evalIn(page, `(() => {
    try { return JSON.parse(document.getElementById("lwpg-scene").textContent).state.sprites.length; } catch (e) { return -1; }
  })()`);
  expect(baked).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);

  // Cleanup the exported package + zip (kept only if the test fails).
  rmSync(root, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
});
