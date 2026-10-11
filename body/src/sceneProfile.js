/**
 * sceneProfile.js — the portable Seekr Scene Profile (`scene.seekr.json`).
 *
 * A profile is the authoritative description of one world: its assets, its
 * environment transform, its Gaussian visual offset and its canonical start
 * pose. It lives WITH the scene assets, as their sibling:
 *
 *     interior_0516_840045/
 *       scene.seekr.json
 *       interior_0516_840045.gs.ply
 *       interior_0516_840045.navmesh
 *       interior_0516_840045.navmesh.glb
 *
 * ── PORTABILITY IS THE POINT ──────────────────────────────────────────────
 * Every asset path inside a profile is RELATIVE TO THE PROFILE'S OWN
 * DIRECTORY. A profile therefore contains no host, no scheme and no
 * filesystem path, and the identical file works when its folder is served
 * from a local HTTP root, from Hugging Face, or from anywhere else.
 * Resolution uses the standard URL algorithm against the profile's URL, so
 * nothing here needs to know which host it is talking to.
 *
 * ── AUTHORITY ─────────────────────────────────────────────────────────────
 * The profile is scene metadata. Browser storage is not, and never becomes,
 * authoritative scene metadata — a future "where did the user leave Seekr?"
 * feature is a separate concern from "what is this scene?".
 *
 * ── THE DESCRIPTOR BOUNDARY ───────────────────────────────────────────────
 * `normalizeSceneProfile()` produces a runtime SceneDescriptor. World and
 * player code consume only that, so it does not matter whether a scene came
 * from a fetched profile, from the bundled catalog in config/scenes.js, or —
 * later — from a WorldLabs export or a user-supplied folder.
 */

import { APP_CONFIG } from "./config/appConfig.js";

/**
 * Resolves a schemaVersion-2 `{source, path}` descriptor against the ONE local
 * dataset root. Both logical sources (seekr, habitatGs) live in the same
 * prepared local package, so they collapse onto the same base URL — the old
 * "LOCAL MODE WINS" rule. Nothing is fetched from Hugging Face.
 */
export function resolveLogicalAsset(descriptor) {
  const path = descriptor?.path;
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("[sceneProfile] An asset descriptor needs a non-empty path");
  }
  const base = APP_CONFIG.habitatDataUrl.replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
}

/** Profile schema versions this build understands. */

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);

/**
 * The logical dataset names a v2 asset descriptor may name.
 *
 * Validated here so a typo fails at load with a readable message, rather than
 * at fetch time as a 404 against a base URL nobody expected.
 */
export const LOGICAL_ASSET_SOURCES = Object.freeze(["seekr", "habitatGs"]);

/**
 * Is this a schemaVersion-2 asset descriptor?
 *
 * v1 assets are plain profile-relative strings; v2 assets are
 * `{source, path}` objects naming which dataset the file belongs to. Both
 * shapes are accepted so existing v1 profiles — the bundled sample world and
 * any local fixture — keep loading unchanged.
 */
export function isAssetDescriptor(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export const SUPPORTED_UNITS = Object.freeze(["meters"]);
export const SUPPORTED_UP_AXES = Object.freeze(["Y"]);

/**
 * Scale of one source/world coordinate unit, in metres, when a profile
 * declares no `geometry` block. Profiles authored before the block existed are
 * all metre-scale captures, so omitting it must mean exactly what they already
 * behaved as.
 */
export const DEFAULT_METERS_PER_UNIT = 1.0;

/** The four asset slots a profile may declare. Only `splat` is required. */
export const ASSET_KEYS = Object.freeze([
  "splat",
  "habitatNavmesh",
  "seekrNavmesh",
  "collider",
]);

const isVec3 = (v) =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

const isRelativePath = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p) && // no scheme (http:, file:, C:)
  !p.startsWith("/") && // not root-absolute
  !p.startsWith("\\");

/**
 * Validates a parsed profile object.
 *
 * Returns every problem found rather than throwing on the first, so a broken
 * profile reports as one actionable list.
 *
 * @param {object} profile
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSceneProfile(profile) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { valid: false, errors: ["profile must be a JSON object"] };
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(profile.schemaVersion)) {
    fail(
      `schemaVersion ${JSON.stringify(profile.schemaVersion)} is not supported ` +
        `(supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`,
    );
  }

  if (typeof profile.id !== "string" || profile.id.trim() === "") {
    fail("id must be a non-empty string");
  }

  if (!SUPPORTED_UNITS.includes(profile.units)) {
    fail(
      `units ${JSON.stringify(profile.units)} is not supported ` +
        `(supported: ${SUPPORTED_UNITS.join(", ")})`,
    );
  }

  if (!SUPPORTED_UP_AXES.includes(profile.upAxis)) {
    fail(
      `upAxis ${JSON.stringify(profile.upAxis)} is not supported ` +
        `(supported: ${SUPPORTED_UP_AXES.join(", ")})`,
    );
  }

  // ── geometry (optional) ─────────────────────────────────────────────────
  // `metersPerUnit` is how many metres one source coordinate unit measures —
  // a property of the CAPTURE. It is deliberately not the same number as
  // `environment.scale`, which is runtime calibration an operator may drag.
  // Absent means DEFAULT_METERS_PER_UNIT, so every profile written before this
  // block existed stays valid and behaves identically.
  const geometry = profile.geometry;
  if (geometry !== null && geometry !== undefined) {
    if (typeof geometry !== "object" || Array.isArray(geometry)) {
      fail("geometry must be null or an object");
    } else if (
      !Number.isFinite(geometry.metersPerUnit) ||
      geometry.metersPerUnit <= 0
    ) {
      fail(
        "geometry.metersPerUnit must be a finite number greater than 0 " +
          `(got ${JSON.stringify(geometry.metersPerUnit)})`,
      );
    }
  }

  // ── habitat (optional) ───────────────────────────────────────
  // `habitatToSeekr` states the rigid transform from the Habitat benchmark
  // frame into the Seekr runtime frame, so the benchmark never has to assume
  // one. Optional because a scene with no ObjectNav episodes needs none — but
  // when a benchmark asks for it and it is absent, that is an explicit
  // failure, not an assumed identity. See habitatFrame.js.
  const habitat = profile.habitat;
  if (habitat !== null && habitat !== undefined) {
    if (typeof habitat !== "object" || Array.isArray(habitat)) {
      fail("habitat must be null or an object");
    } else {
      const t = habitat.habitatToSeekr;
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        fail("habitat.habitatToSeekr must be an object");
      } else {
        if (!isVec3(t.position)) {
          fail("habitat.habitatToSeekr.position must be 3 finite numbers");
        }
        if (!isVec3(t.rotationDeg)) {
          fail("habitat.habitatToSeekr.rotationDeg must be 3 finite numbers");
        }
        if (!Number.isFinite(t.scale) || t.scale <= 0) {
          fail(
            "habitat.habitatToSeekr.scale must be a finite number greater " +
              `than 0 (got ${JSON.stringify(t.scale)})`,
          );
        }
      }
    }
  }

  // ── assets ──────────────────────────────────────────────────────────────
  const assets = profile.assets;
  if (!assets || typeof assets !== "object") {
    fail("assets must be an object");
  } else {
    // Each asset is EITHER a v1 profile-relative string OR a v2
    // `{source, path}` descriptor. A malformed v2 descriptor is rejected
    // rather than reinterpreted: guessing at a missing source would silently
    // fetch from the wrong dataset.
    const checkAsset = (key, value, { required = false } = {}) => {
      if (value === null || value === undefined) {
        if (required) {
          fail(`assets.${key} is required`);
        }
        return;
      }

      if (isAssetDescriptor(value)) {
        if (!LOGICAL_ASSET_SOURCES.includes(value.source)) {
          fail(
            `assets.${key}.source must be one of ` +
              `${LOGICAL_ASSET_SOURCES.join(", ")} (got ${JSON.stringify(value.source)})`,
          );
        }
        if (!isRelativePath(value.path)) {
          fail(
            `assets.${key}.path must be a dataset-relative path ` +
              "(no scheme, no leading slash, no drive letter)",
          );
        }
        return;
      }

      if (!isRelativePath(value)) {
        fail(
          `assets.${key} must be null, a profile-relative path, or a ` +
            "{ source, path } descriptor",
        );
      }
    };

    checkAsset("splat", assets.splat, { required: true });
    for (const key of ["habitatNavmesh", "seekrNavmesh", "collider"]) {
      checkAsset(key, assets[key]);
    }
  }

  // ── environment ─────────────────────────────────────────────────────────
  const env = profile.environment;
  if (!env || typeof env !== "object") {
    fail("environment must be an object");
  } else {
    if (!isVec3(env.position)) fail("environment.position must be 3 finite numbers");
    if (!isVec3(env.rotationDeg)) fail("environment.rotationDeg must be 3 finite numbers");
    if (!Number.isFinite(env.scale)) fail("environment.scale must be a finite number");
  }

  // ── visualOffset ────────────────────────────────────────────────────────
  const offset = profile.visualOffset;
  if (!offset || typeof offset !== "object") {
    fail("visualOffset must be an object");
  } else {
    if (!isVec3(offset.position)) fail("visualOffset.position must be 3 finite numbers");
    if (!isVec3(offset.rotationDeg)) fail("visualOffset.rotationDeg must be 3 finite numbers");
  }

  // ── defaultStart (optional) ─────────────────────────────────────────────
  const start = profile.defaultStart;
  if (start !== null && start !== undefined) {
    if (typeof start !== "object" || Array.isArray(start)) {
      fail("defaultStart must be null or an object");
    } else {
      if (!isVec3(start.position)) fail("defaultStart.position must be 3 finite numbers");
      if (!Number.isFinite(start.headingDeg)) fail("defaultStart.headingDeg must be finite");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Reads a validated profile's metres-per-unit, defaulting when absent.
 *
 * Reads only — the raw profile is never given a `geometry` block it did not
 * declare, so an old profile round-trips through authoring unchanged.
 *
 * @param {object} profile
 * @returns {number}
 */
export function readMetersPerUnit(profile) {
  const value = profile?.geometry?.metersPerUnit;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_METERS_PER_UNIT;
}

/**
 * Reads a validated profile's Habitat→Seekr calibration, deep-copied.
 *
 * Returns `null` when the profile declares none. Null is a real answer here,
 * not a default: benchmark code must fail loudly on a missing calibration
 * rather than quietly proceeding as if the frames coincided.
 *
 * @param {object} profile
 * @returns {{habitatToSeekr: {position: number[], rotationDeg: number[], scale: number}}|null}
 */
export function readHabitatCalibration(profile) {
  const t = profile?.habitat?.habitatToSeekr;
  if (!t) return null;
  return {
    habitatToSeekr: {
      position: [...t.position],
      rotationDeg: [...t.rotationDeg],
      scale: t.scale,
    },
  };
}

/**
 * Deep copy of a parsed profile. Plain JSON in, plain JSON out — no shared
 * arrays, so editing a draft can never reach back into the loaded profile.
 */
export function clonePortableProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

/**
 * Resolves one profile asset to an absolute URL.
 *
 * Two shapes, two rules:
 *
 *   v1 string      resolved against the PROFILE's own URL, so a profile whose
 *                  assets sit beside it works unchanged from any host.
 *
 *   v2 descriptor  resolved against the LOGICAL SOURCE it names, because the
 *                  assets are no longer siblings: the profile and the Seekr
 *                  navmesh are ours, while the splat and native navmesh are
 *                  upstream Habitat-GS at a pinned revision. Resolving those
 *                  relative to the profile would fetch them from the wrong
 *                  dataset.
 *
 * `resolveLogical` is injected so this module keeps no knowledge of base URLs
 * and stays testable without APP_CONFIG.
 *
 * @param {string} profileUrl  absolute URL of scene.seekr.json
 * @param {string|{source: string, path: string}|null} asset
 * @param {(descriptor: object) => string} [resolveLogical]
 * @returns {string|null} absolute URL, or null when the asset is absent
 */
export function resolveProfileAssetUrl(
  profileUrl,
  asset,
  resolveLogical = resolveLogicalAsset,
) {
  if (!asset) return null;
  if (isAssetDescriptor(asset)) return resolveLogical(asset);
  return new URL(asset, profileUrl).href;
}

/**
 * Turns a validated profile into the runtime SceneDescriptor that world and
 * player code consume. Asset URLs come out absolute and already resolved
 * against the profile's location.
 *
 * The resolver is pluggable so a package read from a local folder can map the
 * same relative paths onto runtime object URLs. Resolution is a RUNTIME
 * concern only — `rawProfile` keeps the portable relative paths either way.
 *
 * @param {object} profile
 * @param {string} profileUrl
 * @param {(profileUrl: string, relativePath: string|null) => string|null} [resolveAsset]
 * @returns {object} SceneDescriptor
 */
export function normalizeSceneProfile(
  profile,
  profileUrl,
  resolveAsset = resolveProfileAssetUrl,
) {
  const { valid, errors } = validateSceneProfile(profile);
  if (!valid) {
    throw new Error(
      `[sceneProfile] Invalid profile at ${profileUrl}:\n  - ${errors.join("\n  - ")}`,
    );
  }

  const assets = {};
  for (const key of ASSET_KEYS) {
    assets[key] = resolveAsset(profileUrl, profile.assets[key] ?? null);
  }

  const start = profile.defaultStart ?? null;

  return {
    // The portable profile exactly as loaded, kept so authoring can edit and
    // re-export it. Deep-copied: the descriptor's resolved absolute URLs must
    // never leak back into the portable form.
    rawProfile: clonePortableProfile(profile),
    id: profile.id,
    displayName: profile.displayName ?? profile.id,
    source: "profile",
    profileUrl,
    units: profile.units,
    upAxis: profile.upAxis,
    geometry: { metersPerUnit: readMetersPerUnit(profile) },
    habitat: readHabitatCalibration(profile),
    assets,
    environment: {
      position: [...profile.environment.position],
      rotationDeg: [...profile.environment.rotationDeg],
      scale: profile.environment.scale,
    },
    visualOffset: {
      position: [...profile.visualOffset.position],
      rotationDeg: [...profile.visualOffset.rotationDeg],
    },
    defaultStart: start
      ? { position: [...start.position], headingDeg: start.headingDeg }
      : null,
  };
}

/**
 * Builds the same SceneDescriptor from a bundled catalog entry whose assets
 * are already app-servable (the sample world in config/scenes.js). Keeps the
 * un-migrated inline scene on the identical runtime boundary as a profile.
 *
 * @param {object} scene  entry from SCENES with assetSource "app"
 * @returns {object} SceneDescriptor
 */
export function descriptorFromInlineScene(scene) {
  const assets = {};
  for (const key of ASSET_KEYS) assets[key] = scene.assets?.[key] ?? null;

  return {
    // Inline catalog scenes have no portable profile to author against; the
    // authoring UI reports that rather than inventing one from app-served
    // paths, which are not portable.
    rawProfile: null,
    id: scene.id,
    displayName: scene.displayName ?? scene.id,
    source: "inline",
    profileUrl: null,
    units: "meters",
    upAxis: "Y",
    geometry: { metersPerUnit: DEFAULT_METERS_PER_UNIT },
    // Inline catalog scenes carry no Habitat benchmark calibration. Null, not
    // an invented identity — running a Habitat benchmark here must fail.
    habitat: null,
    assets,
    environment: {
      position: [...scene.environment.position],
      rotationDeg: [...scene.environment.rotationDeg],
      scale: scene.environment.scale,
    },
    visualOffset: {
      position: [...scene.visualOffset.position],
      rotationDeg: [...scene.visualOffset.rotationDeg],
    },
    defaultStart: scene.defaultStart
      ? {
          position: [...scene.defaultStart.position],
          headingDeg: scene.defaultStart.headingDeg,
        }
      : null,
  };
}

/**
 * Fetches, validates and normalizes a scene profile.
 *
 * Failures are explicit and name the profile URL — a bad profile is a
 * configuration error to be seen, never something to paper over by silently
 * falling back to another scene or to stale inline values.
 *
 * @param {string} profileUrl
 * @param {typeof fetch} [fetchImpl]  injectable for tests
 * @returns {Promise<object>} SceneDescriptor
 */
export async function loadSceneProfile(
  profileUrl,
  fetchImpl = fetch,
  assetConfig = undefined,
) {
  let response;
  try {
    response = await fetchImpl(profileUrl);
  } catch (err) {
    throw new Error(
      `[sceneProfile] Could not fetch profile ${profileUrl}: ${err?.message ?? err}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `[sceneProfile] Could not fetch profile ${profileUrl}: ` +
        `HTTP ${response.status} ${response.statusText ?? ""}`.trim(),
    );
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new Error(
      `[sceneProfile] Profile ${profileUrl} is not valid JSON: ${err?.message ?? err}`,
    );
  }

  // The LIVE asset configuration is threaded down to logical-source
  // resolution. Without it, resolveLogicalAsset() falls back to the module's
  // startup APP_CONFIG.assets — so a profile fetched from the Local Dataset
  // still resolved its v2 assets against the REMOTE datasets, and Local mode
  // silently loaded half its scene from Hugging Face.
  //
  // `undefined` keeps the existing default, so a caller with no opinion (and
  // every schemaVersion-1 profile, whose assets resolve against the profile
  // URL) behaves exactly as before.
  return normalizeSceneProfile(parsed, profileUrl, (url, asset) =>
    resolveProfileAssetUrl(url, asset, (descriptor) =>
      resolveLogicalAsset(descriptor, assetConfig),
    ),
  );
}
