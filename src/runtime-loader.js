/**
 * Runtime selection for Spine binary skeletons.
 *
 * The vendored runtimes expose namespaced globals:
 *   - window.spine40  (spine-webgl 4.0.31, loads Spine 4.0.x .skel)
 *   - window.spine41  (spine-webgl 4.1.56, loads Spine 4.1.x .skel)
 *
 * The Spine 4.0 and 4.1 binary formats differ (4.1 added sequence
 * attachments and a deform-timeline type byte), and neither runtime branches
 * on the skeleton version, so each .skel must be decoded by the runtime that
 * matches its own version. We detect the version from the file header and
 * dispatch accordingly — no per-character configuration needed.
 */

/**
 * Read the version string from a Spine binary .skel header.
 * Layout: 4-byte hash (low) + 4-byte hash (high) + length-prefixed string.
 * @param {Uint8Array} bytes
 * @returns {string|null} e.g. "4.0.47" or null if the header is malformed.
 */
export function detectSkeletonVersion(bytes) {
  if (!bytes || bytes.length < 9) return null;
  const len = bytes[8];
  if (!len || 9 + len > bytes.length) return null;
  let version = "";
  for (let i = 0; i < len; i++) version += String.fromCharCode(bytes[9 + i]);
  return version;
}

/**
 * Return the runtime namespace able to decode the given skeleton version.
 * @param {string|null} version
 * @returns {object} window.spine40 or window.spine41
 */
export function pickRuntime(version) {
  const majorMinor = (version || "").split(".").slice(0, 2).join(".");
  if (majorMinor === "4.0") {
    if (!window.spine40) throw new Error("Spine 4.0 runtime failed to load (vendor/spine-4.0.31).");
    return window.spine40;
  }
  if (majorMinor === "4.1") {
    if (!window.spine41) throw new Error("Spine 4.1 runtime failed to load (vendor/spine-4.1.56).");
    return window.spine41;
  }
  throw new Error(
    `Unsupported Spine skeleton version "${version || "unknown"}" — this viewer supports 4.0.x and 4.1.x.`
  );
}
