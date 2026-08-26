const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const INDEX_PATH = path.join(PUBLIC_DIR, "index.html");
const SERVICE_WORKER_PATH = path.join(PUBLIC_DIR, "sw.js");
const APP_PATH = path.join(PUBLIC_DIR, "app.js");
const LOCK_PATH = path.join(ROOT, "data", "asset-version-lock.json");

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

// Pulls every "<file>?v=<tag>" reference out of a source file. index.html writes them as
// "./styles.css?v=x" in href/src attributes; sw.js writes them as "/styles.css?v=x" inside
// APP_SHELL. The two must agree, which is asserted separately; here the last one wins because
// a disagreement is reported by that test with a far better message than this one could give.
function collectVersionedReferences(source) {
  const references = new Map();
  const pattern = /["'/.]([A-Za-z0-9._-]+\.[A-Za-z0-9]+)\?v=([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) references.set(match[1], match[2]);
  return references;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// The published fingerprint of every asset the page or the service worker asks for by version,
// plus the two shell files that carry no "?v=" of their own. index.html and sw.js are cached
// unversioned, so CACHE_NAME is what busts them; it is their version in every sense that matters.
function buildAssetVersionLock() {
  const index = fs.readFileSync(INDEX_PATH, "utf8");
  const serviceWorker = fs.readFileSync(SERVICE_WORKER_PATH, "utf8");
  const references = new Map([
    ...collectVersionedReferences(index),
    ...collectVersionedReferences(serviceWorker)
  ]);

  const assets = {};
  for (const file of [...references.keys()].sort()) {
    const absolute = path.join(PUBLIC_DIR, file);
    if (!fs.existsSync(absolute)) continue;
    assets[file] = { version: references.get(file), sha256: sha256(absolute) };
  }

  return {
    note: "Written by scripts/lib/asset-versions.js. Run npm run lock:assets after bumping a ?v= tag by hand.",
    shell: {
      cacheName: serviceWorker.match(/const CACHE_NAME = "([^"]+)"/)?.[1] || null,
      files: { "index.html": sha256(INDEX_PATH), "sw.js": sha256(SERVICE_WORKER_PATH) }
    },
    assets
  };
}

function readAssetVersionLock() {
  if (!fs.existsSync(LOCK_PATH)) return null;
  return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
}

// The whole point of the lock: an asset whose bytes moved while its cache-busting version stood
// still is an asset installed clients will never fetch again. Returns one sentence per offender,
// empty when every change carries a new version. A version that moved without the lock being
// refreshed is not an offense — it is a stale lock, which the caller reports separately.
function findUnbumpedAssets(lock, current = buildAssetVersionLock()) {
  if (!lock) return [];
  const offenses = [];

  for (const [file, entry] of Object.entries(current.assets)) {
    const published = lock.assets?.[file];
    if (!published || published.version !== entry.version) continue;
    if (published.sha256 !== entry.sha256) {
      offenses.push(`public/${file} changed but still ships as ?v=${entry.version}`);
    }
  }

  const shellChanged = Object.entries(current.shell.files)
    .filter(([file, digest]) => lock.shell?.files?.[file] && lock.shell.files[file] !== digest)
    .map(([file]) => `public/${file}`);
  if (shellChanged.length && lock.shell?.cacheName === current.shell.cacheName) {
    offenses.push(`${shellChanged.join(" and ")} changed but the shell still caches as ${current.shell.cacheName}`);
  }

  return offenses;
}

function writeAssetVersionLock(lock = buildAssetVersionLock()) {
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return lock;
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

  // This bump moves app.js, styles.css, the two inventory payloads and the shell. Anything else
  // in public/ keeps the tag it already carries, so an edit sitting in one of those files would
  // ride out under a version installed clients have cached. Catch it before writing anything.
  const untouched = findUnbumpedAssets(readAssetVersionLock()).filter((offense) => {
    const file = offense.match(/^public\/([A-Za-z0-9._-]+)/)?.[1];
    return !["app.js", "styles.css", "index.html", "sw.js", "denver-west-routes.js", "denver-west-routes.json"].includes(file);
  });
  if (untouched.length) {
    throw new Error(`Bump these by hand first; this bump does not retag them:\n  ${untouched.join("\n  ")}`);
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
  // The inventory script carries whatever tag was current the last time the payload moved, which
  // is not the current app tag once a UI-only change has shipped in between. Retag it by name.
  const retagInventoryScript = (source) =>
    source.replace(/denver-west-routes\.js\?v=[A-Za-z0-9._-]+/g, `denver-west-routes.js?v=${next.assetTag}`);
  const index = retagInventoryScript(
    fs.readFileSync(INDEX_PATH, "utf8").replaceAll(`?v=${current.assetTag}`, `?v=${next.assetTag}`)
  );
  const serviceWorker = retagInventoryScript(
    fs.readFileSync(SERVICE_WORKER_PATH, "utf8")
      .replace(/curb-alerts-shell-v\d+/g, `curb-alerts-shell-v${next.shellVersion}`)
      .replaceAll(`?v=${current.assetTag}`, `?v=${next.assetTag}`)
      .replace(/denver-west-routes\.json\?v=\d+/g, `denver-west-routes.json?v=${next.inventoryVersion}`)
  );

  fs.writeFileSync(APP_PATH, app, "utf8");
  fs.writeFileSync(INDEX_PATH, index, "utf8");
  fs.writeFileSync(SERVICE_WORKER_PATH, serviceWorker, "utf8");
  writeAssetVersionLock();

  return { previous: current, next };
}

module.exports = {
  readCurrentVersions,
  bumpAssetVersions,
  buildAssetVersionLock,
  readAssetVersionLock,
  writeAssetVersionLock,
  findUnbumpedAssets,
  LOCK_PATH
};
