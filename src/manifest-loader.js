/**
 * Loads the character manifest.
 *
 * Primary source: the dev server's dynamic `api/manifest` endpoint, which
 * scans assets/ on every request — newly added folders show up on the next
 * page load with no manual step.
 *
 * Fallback: the bundled src/manifest.js (generated), used when the app is
 * served without the API (plain static hosting, packaged Wallpaper Engine
 * wallpaper).
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
      if (Array.isArray(data.characters) && data.characters.length > 0) {
        return data.characters;
      }
    }
  } catch {
    // No API (static deployment) — fall through to the bundled manifest.
  }
  return BUNDLED_CHARACTERS;
}
