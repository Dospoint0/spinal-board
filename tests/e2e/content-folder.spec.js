/**
 * Content-folder control + picker tab scrolling.
 *
 * - The Add-character picker can repoint the server's content library at
 *   another folder at runtime ("Library folder…" row -> POST /api/content);
 *   the choice is remembered in localStorage and re-applied on the next load
 *   (applyPersistedContentRoot), so a chosen library survives restarts.
 * - The tab/subtab strips wrap onto up to two rows and fall back to ONE line
 *   that scrolls horizontally (.scroll) when there are more folders than fit.
 *
 * These specs build throwaway libraries (a tiny 1x1 PNG per item) under
 * <repo>/.test-content-folder and always reset the server root afterwards.
 */
import { test, expect } from "playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalIn, waitTruthy } from "./helpers.js";

const ROOT = process.cwd();
const TMP = join(ROOT, ".test-content-folder");

// A 1x1 transparent PNG — enough for a scanner "media" item, no fixtures needed.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Open the editor without requiring any particular library content. */
async function openEditor(page) {
  await page.goto("/");
  await waitTruthy(page, `!!window.__spineViewer`);
}

/** Create a library: `tabs` top-level folders with one image each, plus one
 *  folder `zzsub` holding `subtabs` subfolders with one image each. */
function makeLibrary(root, { tabs = 3, subtabs = 0 } = {}) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < tabs; i++) {
    const d = join(root, `tab${String(i).padStart(2, "0")}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "a.png"), PNG);
  }
  if (subtabs > 0) {
    const sub = join(root, "zzsub");
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < subtabs; i++) {
      const d = join(sub, `s${String(i).padStart(2, "0")}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "a.png"), PNG);
    }
  }
  return root;
}

async function contentInfo(page) {
  return evalIn(page, `window.__spineViewer.content.get()`);
}

/** Current document's unique boot id (changes on every reload). */
async function bootId(page) {
  return evalIn(page, `window.__spineViewer.bootId`);
}

async function resetRoot(request) {
  const res = await request.post("/api/content", { data: { dir: "" } });
  expect(res.ok()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  await resetRoot(request);
});

test.afterEach(async ({ request }) => {
  rmSync(TMP, { recursive: true, force: true });
  await resetRoot(request);
});

test("content folder: runtime switch is persisted and the tab/subtab strips scroll horizontally", async ({ page, request }) => {
  // Default state: server reports dir === defaultDir.
  const start = await (await request.get("/api/content")).json();
  expect(start.dir).toBe(start.defaultDir);

  // A big library: 60 tabs (one of them with 50 subtabs) — far more than the
  // two wrapping rows the strips allow, so they must fall back to scrolling.
  const lib = makeLibrary(TMP, { tabs: 60, subtabs: 50 });
  const expectedChars = 60 + 50;
  const tabCount = 60 + 1; // the 60 tabs + the zzsub tab

  await openEditor(page);
  // Remember the folder (as the UI would) and reload: on boot the app must
  // re-apply it before fetching the manifest.
  const boot = await bootId(page);
  await evalIn(page, `localStorage.setItem("lwpg.contentRoot", ${JSON.stringify(lib)})`);
  await page.reload();
  // Wait until a NEW document has booted on the new library (bootId changed
  // AND that document's manifest holds the 60 tab items + 50 subtab items).
  await waitTruthy(
    page,
    `window.__spineViewer && window.__spineViewer.bootId !== ${JSON.stringify(boot)} && window.__spineViewer.CHARACTERS.length === ${expectedChars}`
  );
  expect((await contentInfo(page)).dir).toBe(lib);

  // Open the picker: the tab strip must be in single-line scroll mode.
  await page.click("#add-char-btn");
  await expect(page.locator("#picker")).toBeVisible();
  await expect(page.locator("#picker-tabs .picker-tab")).toHaveCount(tabCount);
  const tabOverflow = await evalIn(page, `(() => {
    const el = document.getElementById("picker-tabs");
    return { scroll: el.classList.contains("scroll"), sw: el.scrollWidth, cw: el.clientWidth };
  })()`);
  expect(tabOverflow.scroll).toBe(true);
  expect(tabOverflow.sw).toBeGreaterThan(tabOverflow.cw);
  expect(
    await evalIn(page, `(() => { const el = document.getElementById("picker-tabs"); el.scrollLeft = 1000; return el.scrollLeft; })()`)
  ).toBeGreaterThan(0);

  // Open the folder row: it must show the current (switched) folder.
  await page.click("#picker-folder-btn");
  await expect(page.locator("#picker-folder-row")).toBeVisible();
  await expect(page.locator("#picker-folder-input")).toHaveValue(lib);

  // The 50-subtab tab: its subtab strip must also scroll horizontally.
  await page.click('#picker-tabs [data-tab="zzsub"]');
  await expect(page.locator("#picker-subtabs")).toBeVisible();
  await expect(page.locator("#picker-subtabs .picker-tab")).toHaveCount(50);
  const subOverflow = await evalIn(page, `(() => {
    const el = document.getElementById("picker-subtabs");
    return { scroll: el.classList.contains("scroll"), sw: el.scrollWidth, cw: el.clientWidth };
  })()`);
  expect(subOverflow.scroll).toBe(true);
  expect(subOverflow.sw).toBeGreaterThan(subOverflow.cw);

  // Sanity: the subtab strip scrolls horizontally.
  expect(
    await evalIn(page, `(() => { const el = document.getElementById("picker-subtabs"); el.scrollLeft = 500; return el.scrollLeft; })()`)
  ).toBeGreaterThan(0);
});

test("content folder: picker row rejects a missing path, switches via UI, resets to default", async ({ page, request }) => {
  const start = await (await request.get("/api/content")).json();
  const defaultDir = start.defaultDir;
  const lib = makeLibrary(TMP, { tabs: 3 });

  // The UI confirms each real switch/reset; accept every dialog.
  page.on("dialog", (d) => d.accept());

  await openEditor(page);
  await page.click("#add-char-btn");
  await expect(page.locator("#picker")).toBeVisible();

  // Reveal the folder row: prefilled with the current (default) folder.
  await page.click("#picker-folder-btn");
  await expect(page.locator("#picker-folder-row")).toBeVisible();
  await expect(page.locator("#picker-folder-input")).toHaveValue(defaultDir);

  // An invalid path must fail with a message, NO dialog and NO reload.
  await page.fill("#picker-folder-input", join(TMP, "does-not-exist"));
  await page.click("#picker-folder-apply");
  await expect(page.locator("#picker-folder-status")).toContainText("Cannot use that folder");
  await expect(page.locator("#picker")).toBeVisible();

  // A real path: confirm the switch dialog; the editor reloads on the library.
  await page.fill("#picker-folder-input", lib);
  const bootBeforeSwitch = await bootId(page);
  await page.click("#picker-folder-apply");
  // Wait until a NEW document is booted whose manifest is the 3-tab library.
  await waitTruthy(
    page,
    `window.__spineViewer && window.__spineViewer.bootId !== ${JSON.stringify(bootBeforeSwitch)} && window.__spineViewer.CHARACTERS.length === 3`
  );
  expect((await contentInfo(page)).dir).toBe(lib);
  // The remembered choice lives in localStorage (boot re-apply uses it).
  expect(await evalIn(page, `localStorage.getItem("lwpg.contentRoot")`)).toBe(lib);

  // The picker now shows exactly the three tabs of the switched library.
  await page.click("#add-char-btn");
  await expect(page.locator("#picker")).toBeVisible();
  await expect(page.locator("#picker-tabs .picker-tab")).toHaveCount(3);

  // Reset via the picker row: back to the default folder.
  await page.click("#picker-folder-btn");
  await expect(page.locator("#picker-folder-row")).toBeVisible();
  const bootBeforeReset = await bootId(page);
  await page.click("#picker-folder-reset");
  // Wait until a NEW document is booted (its manifest is non-empty again).
  await waitTruthy(
    page,
    `window.__spineViewer && window.__spineViewer.bootId !== ${JSON.stringify(bootBeforeReset)} && window.__spineViewer.CHARACTERS.length > 0`
  );
  expect((await contentInfo(page)).dir).toBe(defaultDir);
  expect(await evalIn(page, `localStorage.getItem("lwpg.contentRoot")`)).toBe(null);
});
