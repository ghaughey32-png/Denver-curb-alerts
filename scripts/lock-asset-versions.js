// Records what every versioned asset in public/ looks like at the version it currently ships
// under, so test/static-cache-version.test.js can tell a file that changed with its "?v=" tag
// from one that changed without it. The pipeline scripts call bumpAssetVersions, which writes
// the lock itself; this is the hand-edit path — bump the tag in index.html and sw.js, then run
// this. It refuses to record a change that has no new version behind it, because doing so would
// launder exactly the bug the lock exists to catch.
const {
  buildAssetVersionLock,
  readAssetVersionLock,
  writeAssetVersionLock,
  findUnbumpedAssets,
  LOCK_PATH
} = require("./lib/asset-versions.js");

const relative = (file) => file.slice(file.indexOf("/data/") + 1);

function main() {
  const current = buildAssetVersionLock();
  const published = readAssetVersionLock();
  const offenses = findUnbumpedAssets(published, current);

  if (offenses.length) {
    console.error("Refusing to write the lock; these changed without a new version:\n");
    for (const offense of offenses) console.error(`  ${offense}`);
    console.error("\nBump the ?v= tag in public/index.html and public/sw.js (and CACHE_NAME for");
    console.error("the shell), then run this again.");
    process.exitCode = 1;
    return;
  }

  writeAssetVersionLock(current);
  const moved = Object.entries(current.assets)
    .filter(([file, entry]) => published?.assets?.[file]?.version !== entry.version)
    .map(([file, entry]) => `${file} → ?v=${entry.version}`);
  if (published?.shell?.cacheName !== current.shell.cacheName) {
    moved.push(`shell → ${current.shell.cacheName}`);
  }

  console.log(`Wrote ${relative(LOCK_PATH)}${published ? "" : " for the first time"}.`);
  for (const line of moved) console.log(`  ${line}`);
  if (published && !moved.length) console.log("  no versions moved");
}

main();
