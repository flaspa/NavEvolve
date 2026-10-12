/**
 * config/appConfig.js — application-level defaults.
 *
 * Which scene starts and how the app presents it. Per-scene data lives in
 * scenes.js and in each scene's own scene.seekr.json.
 */
export const APP_CONFIG = Object.freeze({
  /** Scene loaded at startup. Must match an id in SCENES. */
  defaultSceneId: "interior_0637_841444",

  /** Camera mode the app opens in — "first" | "third". */
  defaultView: "first",

  /**
   * Remember the last scene and Seekr pose across a browser reload.
   * false means no localStorage is read or written.
   */
  sessionPersistenceEnabled: true,

  /**
   * URL prefix under which the vite middleware serves the LOCAL Habitat-GS
   * validation package (see vite.config.js). Scene profile paths and their
   * `{source, path}` asset descriptors resolve against this root. Nothing is
   * fetched from Hugging Face at runtime.
   */
  habitatDataUrl: "/habitat",

  /** NavEvolve Brain (brain/server.py): health and MongoDB status over HTTP. */
  // `?brain=http://host:port` overrides this (used to test against a temporary backend).
  brainUrl: new URLSearchParams(globalThis.location?.search ?? "").get("brain") ?? "http://localhost:8000",
});
