const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const INDEX_PATH = path.join(ROOT, "public", "index.html");
const SERVICE_WORKER_PATH = path.join(ROOT, "public", "sw.js");
const APP_PATH = path.join(ROOT, "public", "app.js");

// Four constants across three files have to move together or an installed client
// keeps serving a stale asset out of the service worker cache: the "?v=" tag on
// app.js and denver-west-routes.js, the numeric inventory URL version, the
// localStorage cache key, and CACHE_NAME. test/static-cache-version.test.js
// enforces the agreement; this module is how the pipeline satisfies it without a
// human editing four places by hand.
function readCurrentVersions() {
  const app = fs.readFileSync(APP_PATH, "utf8");
  const index = fs.readFileSync(INDEX_PATH, "utf8");
  const serviceWorker = fs.readFileSync(SERVICE_WORKER_PATH, "utf8");

  return {
    assetTag: index.match(/app\.js\?v=([^"']+)/)?.[1] || null,
    inventoryVersion: Number(app.match(/denver-west-routes\.json\?v=(\d+)/)?.[1]),
    inventoryCacheVersion: Number(app.match(/sloans-lake-full-inventory-cache-v(\d+)/)?.[1]),
    shellVersion: Number(serviceWorker.match(/curb-alerts-shell-v(\d+)/)?.[1])
  };
}

function bumpAssetVersions(assetTag) {
  if (!assetTag || !/^[A-Za-z0-9._-]+$/.test(assetTag)) {
    throw new Error(`Asset tag must be a plain slug, got ${JSON.stringify(assetTag)}`);
  }

  const current = readCurrentVersions();
  for (const [name, value] of Object.entries(current)) {
    if (name !== "assetTag" && !Number.isInteger(value)) {
      throw new Error(`Could not read the current ${name} out of public/; refusing to guess`);
    }
  }
  if (assetTag === current.assetTag) {
    throw new Error(`Asset tag ${assetTag} is already the published one; pick a new tag`);
  }

  const next = {
    assetTag,
    inventoryVersion: current.inventoryVersion + 1,
    inventoryCacheVersion: current.inventoryCacheVersion + 1,
    shellVersion: current.shellVersion + 1
  };

  const app = fs.readFileSync(APP_PATH, "utf8")
    .replace(/sloans-lake-full-inventory-cache-v\d+/g, `sloans-lake-full-inventory-cache-v${next.inventoryCacheVersion}`)
    .replace(/denver-west-routes\.json\?v=\d+/g, `denver-west-routes.json?v=${next.inventoryVersion}`);
  const index = fs.readFileSync(INDEX_PATH, "utf8")
    .replaceAll(`?v=${current.assetTag}`, `?v=${next.assetTag}`);
  const serviceWorker = fs.readFileSync(SERVICE_WORKER_PATH, "utf8")
    .replace(/curb-alerts-shell-v\d+/g, `curb-alerts-shell-v${next.shellVersion}`)
    .replaceAll(`?v=${current.assetTag}`, `?v=${next.assetTag}`)
    .replace(/denver-west-routes\.json\?v=\d+/g, `denver-west-routes.json?v=${next.inventoryVersion}`);

  fs.writeFileSync(APP_PATH, app, "utf8");
  fs.writeFileSync(INDEX_PATH, index, "utf8");
  fs.writeFileSync(SERVICE_WORKER_PATH, serviceWorker, "utf8");

  return { previous: current, next };
}

module.exports = { readCurrentVersions, bumpAssetVersions };
