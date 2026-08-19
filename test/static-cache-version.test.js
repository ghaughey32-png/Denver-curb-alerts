const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function readPublicFile(name) {
  return fs.readFileSync(path.join(ROOT, "public", name), "utf8");
}

// Pulls every "<file>?v=<version>" reference out of a source file. index.html writes them as
// "./styles.css?v=x" in href/src attributes; sw.js writes them as "/styles.css?v=x" inside APP_SHELL.
function collectVersionedAssets(source) {
  const assets = new Map();
  const pattern = /["'/.]([A-Za-z0-9._-]+\.[A-Za-z0-9]+)\?v=([^"']+)["']/g;
  let match = pattern.exec(source);
  while (match) {
    assets.set(match[1], match[2]);
    match = pattern.exec(source);
  }
  return assets;
}

function appShellSource(serviceWorker) {
  const start = serviceWorker.indexOf("const APP_SHELL = [");
  assert.notEqual(start, -1, "sw.js should declare an APP_SHELL array");
  const end = serviceWorker.indexOf("];", start);
  assert.notEqual(end, -1, "sw.js APP_SHELL array should be closed");
  return serviceWorker.slice(start, end);
}

test("the page, app, and service worker request matching inventory assets", () => {
  const app = readPublicFile("app.js");
  const index = readPublicFile("index.html");
  const serviceWorker = readPublicFile("sw.js");

  const inventoryVersion = app.match(/STATIC_ROUTE_INVENTORY_URL = "\.\/denver-west-routes\.json\?v=([^"]+)"/)?.[1];
  const appVersion = index.match(/app\.js\?v=([^"]+)/)?.[1];

  assert.ok(inventoryVersion, "app.js should version the JSON inventory URL");
  assert.ok(appVersion, "index.html should version app.js");
  assert.match(serviceWorker, new RegExp(`denver-west-routes\\.json\\?v=${inventoryVersion}`));
  assert.match(serviceWorker, new RegExp(`app\\.js\\?v=${appVersion}`));
});

// The service worker matches cached responses with caches.match(request) and no ignoreSearch, so a
// precached "styles.css?v=A" can never satisfy a page request for "styles.css?v=B". Any drift between
// index.html and APP_SHELL silently drops that asset from the offline fallback.
test("every versioned asset agrees between index.html and the service worker shell", () => {
  const pageAssets = collectVersionedAssets(readPublicFile("index.html"));
  const shellAssets = collectVersionedAssets(appShellSource(readPublicFile("sw.js")));

  assert.ok(pageAssets.size > 0, "index.html should reference versioned assets");
  assert.ok(shellAssets.size > 0, "sw.js APP_SHELL should reference versioned assets");

  const mismatches = [];
  for (const [file, pageVersion] of pageAssets) {
    const shellVersion = shellAssets.get(file);
    if (shellVersion && shellVersion !== pageVersion) {
      mismatches.push(`${file}: index.html requests ?v=${pageVersion} but sw.js precaches ?v=${shellVersion}`);
    }
  }

  assert.deepEqual(
    mismatches,
    [],
    `Versioned assets drifted between index.html and sw.js APP_SHELL:\n  ${mismatches.join("\n  ")}`
  );
});

test("the service worker cache name is bumped alongside the app shell", () => {
  const serviceWorker = readPublicFile("sw.js");
  const cacheName = serviceWorker.match(/const CACHE_NAME = "([^"]+)"/)?.[1];

  assert.ok(cacheName, "sw.js should declare CACHE_NAME");
  assert.match(cacheName, /^curb-alerts-shell-v\d+$/, "CACHE_NAME should stay on the curb-alerts-shell-v<n> scheme");
});
