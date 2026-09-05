/**
 * Runtime selection for Spine skeletons (binary .skel AND .json).
 *
 * The vendored runtimes expose namespaced globals:
 *   - window.spine37  (spine-webgl 3.7.94, loads Spine 3.7.x .json)
 *   - window.spine38  (spine-webgl 3.8.95, loads Spine 3.8.x .skel/.json)
 *   - window.spine40  (spine-webgl 4.0.31, loads Spine 4.0.x .skel)
 *   - window.spine41  (spine-webgl 4.1.56, loads Spine 4.1.x .skel)
 *
 * The binary formats differ between major versions (4.0 -> 4.1 changed the
 * format, 3.7 -> 3.8 differs too) and the runtimes do not branch on the
 * skeleton version, so each skeleton must be decoded by the runtime that
 * matches its own version header. JSON skeletons carry the version in their
 * "skeleton"."spine" field. We detect version + format from the file and
 * dispatch accordingly — no per-character configuration needed.
 */

/**
 * Version/label tables keyed by the skeleton's major.minor prefix.
 * Order matters for iteration; dispatch only uses direct lookups.
 */
const RUNTIMES_BY_MAJOR_MINOR = {
  "3.7": { global: "spine37", label: "3.7.94" },
  "3.8": { global: "spine38", label: "3.8.95" },
  "4.0": { global: "spine40", label: "4.0.31" },
  "4.1": { global: "spine41", label: "4.1.56" },
};

/** The public version string the runtime understands ("3.8.99" -> "3.8"). */
const VERSION_RE = /^(\d+)\.(\d+)/;

function majorMinor(version) {
  const m = VERSION_RE.exec(version || "");
  return m ? `${m[1]}.${m[2]}` : "";
}

/**
 * Read the version string from a Spine binary .skel header.
 *
 * The header layout differs by export era (4.x: 8 raw hash bytes then the
 * version; 3.x: a length-prefixed hash then the version), so instead of
 * trusting one fixed offset we scan the first bytes for the version string
 * itself — a small length byte immediately followed by ASCII digits like
 * "4.0.47" / "3.8.99". Binary hashes are opaque bytes, so a false positive
 * before the real version is effectively impossible in this window.
 * @param {Uint8Array} bytes
 * @returns {string|null} e.g. "4.0.47", "3.8.99" or null if malformed.
 */
export function detectSkeletonVersion(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const maxScan = Math.min(bytes.length - 3, 96);
  for (let i = 0; i < maxScan; i++) {
    const len = bytes[i];
    if (!len || len < 1 || len > 16 || i + 1 + len > bytes.length) continue;
    let s = "";
    for (let j = 0; j < len; j++) {
      const c = bytes[i + 1 + j];
      if (c < 32 || c > 126) break; // version string may share its length with the next field
      s += String.fromCharCode(c);
    }
    if (s.length < 4 || !VERSION_RE.test(s)) continue;
    return s;
  }
  return null;
}

/** Pull the version from a JSON skeleton's "skeleton"."spine" field. */
function jsonSkeletonVersion(text) {
  const m = /"spine"\s*:\s*"([^"]+)"/.exec(text || "");
  return m ? m[1] : null;
}

/**
 * Inspect a skeleton payload (bytes + decoded text) and report its format and
 * version. JSON skeletons are plain text beginning with '{' (games commonly
 * ship them misnamed with a .skel extension, which is why we sniff content).
 * @param {Uint8Array} bytes
 * @param {string} text decoded UTF-8 of `bytes`
 * @returns {{kind: "json"|"binary", version: string|null}}
 */
export function detectSkeleton(bytes, text) {
  const trimmed = String(text || "").trimStart();
  if (trimmed.startsWith("{")) {
    return { kind: "json", version: jsonSkeletonVersion(text) };
  }
  return { kind: "binary", version: detectSkeletonVersion(bytes) };
}

/** Human label for the runtime that decodes `version` (used in status text). */
export function runtimeLabelFor(version) {
  const info = RUNTIMES_BY_MAJOR_MINOR[majorMinor(version)];
  return info ? info.label : null;
}

/**
 * Return the runtime namespace able to decode the given skeleton version.
 * @param {string|null} version
 * @returns {object} window.spine37 | window.spine38 | window.spine40 | window.spine41
 */
export function pickRuntime(version) {
  const key = majorMinor(version);
  const info = RUNTIMES_BY_MAJOR_MINOR[key];
  if (!info) {
    throw new Error(
      `Unsupported Spine skeleton version "${version || "unknown"}" — this viewer supports 3.7.x, 3.8.x, 4.0.x and 4.1.x.`
    );
  }
  const rt = window[info.global];
  if (!rt) {
    throw new Error(`Spine ${info.label} runtime failed to load (vendor/spine-${info.label}).`);
  }
  return rt;
}

/** True when `runtime` is a 3.x runtime (3.7/3.8 webgl bundles). */
export function isLegacyRuntime(runtime) {
  return runtime === window.spine37 || runtime === window.spine38;
}

/**
 * Atlas texture loader for the legacy (3.7/3.8) runtimes. Their
 * TextureAtlas constructor REQUIRES a texture loader and calls methods on the
 * returned object (setFilters/getImage) while parsing the atlas text. The
 * returned stand-in is only used during parsing: real GL textures are created
 * and attached later by the player (page.texture + region.texture).
 * @returns {(path: string) => object|null}
 */
export function legacyAtlasTextureLoader(runtime) {
  if (!isLegacyRuntime(runtime)) return undefined;
  return () => ({
    setFilters() {},
    setWraps() {},
    setMagFilter() {},
    setMinFilter() {},
    setUWrap() {},
    setVWrap() {},
    bind() {},
    unbind() {},
    update() {},
    restore() {},
    dispose() {},
    getImage() {
      return { width: 1, height: 1 };
    },
  });
}

/**
 * Attach a real GL texture to an atlas page. The 4.x runtimes expose
 * page.setTexture(texture); the 3.x runtimes do not — their parser already
 * set region.texture = page.texture at construction (from the stand-in), and
 * the renderer reads UV-normalizing dimensions from region.texture.getImage(),
 * so every region of the page must be repointed to the real texture.
 */
export function attachPageTexture(page, texture, atlas) {
  if (typeof page.setTexture === "function") {
    page.setTexture(texture);
    return;
  }
  page.texture = texture;
  if (atlas && atlas.regions) {
    for (const region of atlas.regions) {
      if (region.page === page) region.texture = texture;
    }
  }
}
