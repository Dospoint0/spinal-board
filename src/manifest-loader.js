/**
 * Loads the character manifest.
 *
 * Primary source: the dev server's dynamic `api/manifest` endpoint, which
 * scans the content root (assets/ folders) on every request — newly added
 * folders show up on the next page load with no manual step. When the content
 * root is switched at runtime (see main.js + POST /api/content), the manifest
 * describes the CURRENT root, including an empty one (an empty library is a
 * valid state and must NOT fall back to the bundled manifest).
 *
 * Fallback: the bundled src/manifest.js (generated), used only when the app is
 * served WITHOUT the API (plain static hosting, packaged Wallpaper Engine
 * wallpaper) — i.e. when the fetch fails or returns no characters array.
 */
import { CHARACTERS as BUNDLED_CHARACTERS } from "./manifest.js";

/**
 * @returns {Promise<Array<{id: string, name: string, variants: object}>>}
 */
export async function loadCharacters() {
  try {
    const res = await fetch("api/manifest", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.characters)) return data.characters;
    }
  } catch {
    // No API (static deployment) — fall through to the bundled manifest.
  }
  return BUNDLED_CHARACTERS;
}
