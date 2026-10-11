/**
 * sessionId.js — Stable per-browser-tab session ID for ScavengeAI.
 *
 * Contract
 * --------
 * • Generated with crypto.randomUUID() and prefixed with "web-".
 * • Stored in sessionStorage so reconnects within the same tab reuse the
 *   same ID without hitting the server with a brand-new identity.
 * • Each new tab starts with a fresh sessionStorage, so different tabs
 *   automatically receive different IDs — no coordination required.
 * • localStorage is intentionally not used; a page reload in a new tab
 *   must not inherit a previous tab's session.
 * • The raw ID contains only the characters produced by randomUUID()
 *   (hex digits and hyphens) plus the "web-" prefix, so it is already
 *   URL-safe.  brainClient.js still passes it through encodeURIComponent()
 *   before inserting it into the WebSocket path as a defence-in-depth
 *   measure.
 *
 * Testability
 * -----------
 * Both dependencies are injectable so Node.js tests can run without
 * browser globals:
 *   storage  — defaults to globalThis.sessionStorage
 *   genUUID  — defaults to () => globalThis.crypto.randomUUID()
 */

/** sessionStorage key under which the ID is persisted. */
export const SESSION_STORAGE_KEY = "scavengeai_session_id";

/** Prefix prepended to every generated UUID for human readability. */
export const SESSION_ID_PREFIX = "web-";

/**
 * Returns the stable session ID for this browser tab, creating and
 * persisting a new one when none exists yet.
 *
 * Called once at startup in main.js; injectable deps allow unit tests to
 * supply isolated storage instances and deterministic UUID generators.
 *
 * @param {Pick<Storage, "getItem"|"setItem">} [storage]
 *   Defaults to globalThis.sessionStorage.
 * @param {() => string} [genUUID]
 *   Defaults to globalThis.crypto.randomUUID.
 * @returns {string}  e.g. "web-550e8400-e29b-41d4-a716-446655440000"
 */
export function getOrCreateSessionId(
  storage = globalThis.sessionStorage,
  genUUID = () => globalThis.crypto.randomUUID(),
) {
  const existing = storage.getItem(SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const id = SESSION_ID_PREFIX + genUUID();
  storage.setItem(SESSION_STORAGE_KEY, id);

  // Log once so the developer can correlate browser-tab activity with
  // brain-server logs.  The ID itself is not a credential.
  console.log("[session] Browser-tab session ID:", id);

  return id;
}
