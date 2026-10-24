import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Scene data lives OUTSIDE the repo and is never committed. This tiny
 * middleware serves each data root under a URL prefix, dev and preview only:
 *
 *   /habitat/…  Habitat-GS validation package (splats, navmeshes, profiles)
 *   /worlds/…   World Labs scenes (dormant; not in the active registry)
 *
 * The ONE writable file per scene is its calibration profile
 * (`scene.seekr.json`), saved by Controls ▸ AGENT POSE ▸ "Set Current Pose as
 * Scene Start" with a PUT. Nothing else is writable.
 */
const HABITAT_DATA_DIR = path.resolve(
  process.env.SEEKR_HABITAT_DATA_DIR ?? "C:/Flavia/Data/seekr-world-habitat-gs-validation",
);
const LOCAL_WORLDS_DIR = fileURLToPath(new URL("../local-worlds", import.meta.url));

const CONTENT_TYPES = {
  ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".navmesh": "application/octet-stream",
  ".json": "application/json",
};

const MOUNTS = [
  { prefix: "/habitat", dir: HABITAT_DATA_DIR, writable: "scene.seekr.json" },
  { prefix: "/worlds", dir: LOCAL_WORLDS_DIR, writable: "scene-config.json" },
];

function makeHandler({ dir, writable }) {
  return (req, res, next) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const relative = path.normalize(urlPath).replace(/^([/\\])+/, "");
    const file = path.join(dir, relative);

    // Stay inside the data root.
    if (!file.startsWith(dir)) {
      next();
      return;
    }

    // The writable calibration file: <root>/**/<scene-dir>/<writable>, and
    // the scene directory must already exist (we never create scenes).
    const isWritable =
      path.basename(file) === writable && fs.existsSync(path.dirname(file));

    if (isWritable && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
        }
      });
      return;
    }

    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // An explicit 404 for anything under a data mount, never the SPA index.
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: `not found: ${relative}` }));
      return;
    }

    const stat = fs.statSync(file);
    res.setHeader(
      "Content-Type",
      CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    );
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(file).pipe(res);
  };
}

function serveSceneData() {
  const install = (server) => {
    for (const mount of MOUNTS) {
      if (!fs.existsSync(mount.dir)) {
        console.warn(`[scene-data] ${mount.prefix} → ${mount.dir} does not exist`);
      }
      server.middlewares.use(mount.prefix, makeHandler(mount));
    }
  };
  return {
    name: "serve-scene-data",
    configureServer: install,
    configurePreviewServer: install,
  };
}

export default defineConfig({
  plugins: [serveSceneData()],
  server: {
    port: 5000,
  },
  resolve: {
    // Force a single Three.js instance across all packages.
    // @sparkjsdev/spark ships its own Three.js copy; without this Vite creates
    // two bundles and SparkRenderer's shader chunks are invisible to our renderer.
    dedupe: ["three"],
  },
});
