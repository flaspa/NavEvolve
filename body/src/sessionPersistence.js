/**
 * sessionPersistence.js — "where did this user leave Seekr?"
 *
 * Browser convenience state, and nothing more. It remembers the last
 * reloadable scene and the last Explorer pose so a refresh resumes roughly
 * where you were.
 *
 * ── NOT SCENE METADATA ────────────────────────────────────────────────────
 * `scene.seekr.json` remains the canonical authored description of a scene.
 * This module never reads or writes a profile, a draft, `defaultStart`,
 * `visualOffset` or `environment`, and restoring a session must never make a
 * profile look Modified. The two concepts are deliberately unrelated:
 *
 *     scene profile   what this scene IS          authored, version-controlled
 *     session state   where you happened to be    disposable, per-browser
 *
 * ── DELIBERATELY SMALL ────────────────────────────────────────────────────
 * Only a scene id and a pose are stored. No profile JSON, no NavMesh or PLY
 * data, no blob URLs, no File handles, no camera state, no tokens. A browser
 * File cannot be persisted meaningfully, so a scene opened from a local folder
 * is simply not restorable by id and falls back to the configured default.
 *
 * Every operation is failure-tolerant: storage can be unavailable, disabled,
 * full, or hold data a user hand-edited. None of that may stop Seekr loading.
 */

/** One versioned key. Bumping the version retires older records wholesale. */
export const SESSION_STORAGE_KEY = "seekr.session.v1";

/** Schema version of the stored record. */
export const SESSION_SCHEMA_VERSION = 1;

/** How often the running pose is sampled for saving, in milliseconds. */
export const SESSION_SAVE_INTERVAL_MS = 500;

/** Returns localStorage, or null when it is unavailable or blocked. */
export function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some privacy modes throw on mere property access.
    return null;
  }
}

const isVec3 = (v) =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

/**
 * Is this a session record this build can trust?
 *
 * Strict on purpose — a hand-edited or stale record is discarded rather than
 * partially honoured.
 */
export function isValidSessionRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.schemaVersion !== SESSION_SCHEMA_VERSION) return false;
  if (typeof record.sceneId !== "string" || record.sceneId.trim() === "") return false;

  const pose = record.pose;
  if (!pose || typeof pose !== "object") return false;
  if (!isVec3(pose.position)) return false;
  if (!Number.isFinite(pose.headingDeg)) return false;

  return true;
}

/**
 * Builds a record from a live pose. Numbers are copied out, so a later frame
 * cannot mutate what was stored.
 */
export function createSessionRecord(sceneId, position, headingDeg) {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sceneId,
    pose: {
      position: [
        +position.x.toFixed(6),
        +position.y.toFixed(6),
        +position.z.toFixed(6),
      ],
      headingDeg: +headingDeg.toFixed(3),
    },
  };
}

/**
 * Reads the saved session, or null when there is none, it is unreadable, or
 * it fails validation. Never throws.
 *
 * @param {Storage|null} storage
 * @returns {object|null}
 */
export function readSession(storage = defaultStorage()) {
  if (!storage) return null;

  let raw;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[session] Stored session is not valid JSON — ignoring it.");
    return null;
  }

  if (!isValidSessionRecord(parsed)) {
    console.warn("[session] Stored session failed validation — ignoring it.");
    return null;
  }

  return parsed;
}

/**
 * Writes a session record. Returns whether it was actually stored.
 * A storage failure (quota, private mode) is reported once and swallowed.
 */
export function writeSession(record, storage = defaultStorage()) {
  if (!storage || !isValidSessionRecord(record)) return false;

  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch (err) {
    console.warn("[session] Could not save session state:", err?.message ?? err);
    return false;
  }
}

/** Removes the saved session. Never throws. */
export function clearSession(storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing useful to do; the app must keep running regardless.
  }
}

/**
 * The saved pose, but ONLY for the scene it was recorded in.
 *
 * This guard is the whole safety story for pose restore: a pose from scene A
 * applied to scene B could drop Seekr inside a wall or outside the world.
 *
 * @param {object|null} record
 * @param {string|null} sceneId  the scene that actually became active
 * @returns {{position: number[], headingDeg: number}|null}
 */
export function sessionPoseFor(record, sceneId) {
  if (!isValidSessionRecord(record)) return null;
  if (!sceneId || record.sceneId !== sceneId) return null;

  return {
    position: [...record.pose.position],
    headingDeg: record.pose.headingDeg,
  };
}

/**
 * Which scene startup should open.
 *
 * Precedence: a saved scene that the normal catalog can still reopen, else the
 * configured default. A saved scene that cannot be resolved by id — a folder
 * the user opened from disk, or one since removed from the catalog — falls
 * back silently rather than failing to boot.
 *
 * @param {object|null} record
 * @param {string} defaultSceneId
 * @param {(id: string) => object|null} resolveScene  the catalog lookup
 * @returns {{sceneId: string, source: "session"|"default"}}
 */
export function resolveStartupSceneId(record, defaultSceneId, resolveScene) {
  const savedId = isValidSessionRecord(record) ? record.sceneId : null;

  if (savedId && savedId !== defaultSceneId && resolveScene(savedId)) {
    return { sceneId: savedId, source: "session" };
  }
  if (savedId === defaultSceneId) {
    return { sceneId: defaultSceneId, source: "session" };
  }

  return { sceneId: defaultSceneId, source: "default" };
}
