/**
 * config/appConfig.js — application-level defaults.
 *
 * Which scene starts and how the app presents it. Per-scene data lives in
 * scenes.js and in each scene's own scene.seekr.json.
 */
export const APP_CONFIG = Object.freeze({
  /** Scene loaded at startup. Must match an id in SCENES. */
  defaultSceneId: "interior_0516_840045",

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

  /**
   * The Brain server the Body connects to over WebSocket. Only a local Brain
   * for now; the new Brain is built in a later milestone.
   */
  brainUrl: "http://localhost:8000",
});
