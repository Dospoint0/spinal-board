/**
 * Audio catalog — resolves a sprite's audio.
 *
 * Resolution order for a character:
 *   1. CUSTOM AUDIO — audio files stored next to the asset itself with the
 *      asset's base name (e.g. c010_00.wav next to c010_00.skel, then
 *      c010_01.wav, c010_02.wav, …). The dev server's scanner records these
 *      in the manifest (`character.audio`); uploads made while the server is
 *      unavailable live in IndexedDB (`spine-viewer-audio`) and are merged
 *      in. When a character has any custom audio, clicking the sprite plays a
 *      random one of them.
 *   2. BACK-COMPAT CATALOG — the original voice-line catalogue:
 *      audio_assets/<charId>/voicelines.json   -> { lines: [{ category,
 *                                                  dialogue, file, ... }] }
 *      audio_assets/<charId>/*.wav             -> the audio files
 *      audio_assets/<charId>/borrow.txt        -> a single other charId whose
 *                                                 audio this costume reuses
 *      (only used when the character has no custom audio)
 */
const AUDIO_DB = "spine-viewer-audio";
const AUDIO_DB_STORE = "audio";

function openAudioDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(AUDIO_DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persist an uploaded audio blob under `audio:<charId>:<name>`. */
export async function saveAudioUpload(charId, name, blob) {
  const db = await openAudioDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_DB_STORE, "readwrite");
    tx.objectStore(AUDIO_DB_STORE).put(blob, `audio:${charId}:${name}`);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/** Delete an IndexedDB audio upload for a character. */
export async function deleteAudioUpload(charId, name) {
  const db = await openAudioDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_DB_STORE, "readwrite");
    tx.objectStore(AUDIO_DB_STORE).delete(`audio:${charId}:${name}`);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/** List all IndexedDB audio uploads for a character: [{ name, blob }]. */
export async function listAudioUploads(charId) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_DB_STORE, "readonly");
    const store = tx.objectStore(AUDIO_DB_STORE);
    const prefix = `audio:${charId}:`;
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    tx.oncomplete = () => {
      const keys = keysReq.result ?? [];
      const vals = valsReq.result ?? [];
      const out = [];
      for (let i = 0; i < keys.length; i++) {
        if (String(keys[i]).startsWith(prefix)) {
          out.push({ name: String(keys[i]).slice(prefix.length), blob: vals[i] });
        }
      }
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export class AudioCatalog {
  /**
   * @param {Map<string, object>} charactersById
   * @param {{noIdb?: boolean}} [options] noIdb: never touch IndexedDB and skip
   *   the legacy voice-line catalogue fetches — used by the exported wallpaper
   *   (fully offline/static; only manifest-backed custom audio is available).
   */
  constructor(charactersById, options = {}) {
    /** Map<charId, {sourceId, categories:Map, custom?:[{name,url,idb}]} | null> */
    this.charactersById = charactersById;
    this.noIdb = !!options.noIdb;
    this.cache = new Map();
  }

  /** @returns {Promise<{sourceId:string, categories:Map, custom?:Array}|null>} */
  async load(charId) {
    if (this.cache.has(charId)) return this.cache.get(charId);
    const entry = await this._resolve(charId);
    this.cache.set(charId, entry);
    return entry;
  }

  /** Drop the cached resolution (call after upload/delete so the next load
   *  re-resolves from the manifest / IndexedDB). */
  invalidate(charId) {
    this.cache.delete(charId);
  }

  async _resolve(charId) {
    // 1. Custom audio next to the asset (manifest; IndexedDB uploads only in
    //    the editor — the exported wallpaper has no database).
    const custom = await this._customAudio(charId);
    if (custom.length) return { sourceId: charId, categories: new Map(), custom };
    if (this.noIdb) return null; // static export: nothing else exists locally

    // 2. Back-compat: the original voice-line catalogue (+ borrow).
    let entry = await this._fetch(charId);
    if (!entry) {
      const borrowed = await this._borrow(charId);
      if (borrowed) entry = await this._fetch(borrowed);
    }
    return entry || null;
  }

  async _customAudio(charId) {
    const character = this.charactersById.get(charId);
    const out = [];
    const seen = new Set();
    // Files recorded by the manifest scanner (server truth).
    for (const url of character?.audio || []) {
      const name = url.slice(url.lastIndexOf("/") + 1);
      seen.add(name);
      out.push({ name, url, idb: false });
    }
    if (this.noIdb) return out;
    // IndexedDB uploads (static hosting) — skip names the manifest already has.
    try {
      const uploads = await listAudioUploads(charId);
      for (const { name, blob } of uploads) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, url: URL.createObjectURL(blob), idb: true });
      }
    } catch (err) {
      console.warn("cannot read audio uploads:", err);
    }
    return out;
  }

  async _fetch(sourceId) {
    try {
      const res = await fetch(`audio_assets/${sourceId}/voicelines.json`, {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = await res.json();
      const categories = new Map();
      for (const line of data.lines || []) {
        if (!line.file || !line.category) continue;
        if (!categories.has(line.category)) categories.set(line.category, []);
        categories.get(line.category).push({
          category: line.category,
          dialogue: line.dialogue ?? "",
          url: `audio_assets/${sourceId}/${line.file}`,
        });
      }
      if (!categories.size) return null;
      return { sourceId, categories };
    } catch {
      return null;
    }
  }

  async _borrow(charId) {
    try {
      const res = await fetch(`audio_assets/${charId}/borrow.txt`, { cache: "no-store" });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text || null;
    } catch {
      return null;
    }
  }
}
