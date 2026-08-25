// Applies the current city-limits rule to every block already in the manifest,
// for the areas that were imported before the rule existed.
//
// scripts/import-osm-expected-blocks.js drops blocks outside the City and County
// of Denver as an area arrives, which is the right moment for it: an area that
// has never been imported can never carry them. But the rule landed after most
// of the map was already published, and re-importing a published area is exactly
// what AGENTS.md warns against — a fresh Overpass extract has drifted from the
// one the area was built on, and re-importing quietly changes unrelated blocks.
// So the older areas kept blocks in Englewood, Sheridan, Cherry Hills Village
// and the Holly Hills pocket, and the audit published each one as pink: "Denver
// has no schedule here, you do not need to move your car", over curb another
// city sweeps and tickets.
//
// This script asks the same geometric question of the blocks already in the
// manifest, so no new OSM data is involved and nothing but the exclusion flag
// changes. It is idempotent, and worth re-running whenever the boundary geometry
// in scripts/lib/denver-city-limits.js is refined.
//
// It does not touch the published payload. Run `npm run sync:coverage`
// afterwards: that regenerates every pink fallback from the manifest, which both
// withdraws the ones excluded here and trims the ones that merely reach across
// the line (see clipPathToDenver).

const fs = require("fs");
const path = require("path");
const { isOutsideDenverBlock, OUTSIDE_DENVER_EXCLUSION_REASON } = require("./lib/denver-city-limits.js");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "data", "inventory-expected-blocks.json");
const AREAS_PATH = path.join(ROOT, "data", "coverage-pilot-areas.json");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

function main() {
  const manifest = readJson(MANIFEST_PATH);
  const excludedByArea = new Map();

  manifest.blocks = manifest.blocks.map((block) => {
    if (block.excluded || !isOutsideDenverBlock(block.geometry)) return block;
    const area = String(block.id).replace(/-osm-.*$/, "");
    excludedByArea.set(area, (excludedByArea.get(area) || 0) + 1);
    return { ...block, excluded: true, exclusionReason: OUTSIDE_DENVER_EXCLUSION_REASON };
  });

  if (!excludedByArea.size) {
    console.log("Every block in the manifest is already inside the city line; nothing to exclude.");
    return;
  }

  writeJson(MANIFEST_PATH, manifest);
  for (const [area, count] of [...excludedByArea].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${area}: ${count} block(s) excluded`);
  }

  // Each area's public-block count is asserted exactly by
  // test/inventory-coverage.test.js, which reads it from the areas file rather
  // than from a table of its own. Excluding a block changes that count, so the
  // recorded expectation has to move with it or the test asserts against a
  // number the manifest no longer holds.
  const areas = readJson(AREAS_PATH);
  const publicBlocksByArea = manifest.blocks.reduce((counts, block) => {
    if (block.excluded) return counts;
    const area = String(block.id).replace(/-osm-.*$/, "");
    counts.set(area, (counts.get(area) || 0) + 1);
    return counts;
  }, new Map());

  const restated = areas.areas.filter((area) => {
    if (!area.coverage) return false;
    const measured = publicBlocksByArea.get(area.id) || 0;
    if (measured === area.coverage.expectedPublicBlocks) return false;
    console.log(`  ${area.id}: expectedPublicBlocks ${area.coverage.expectedPublicBlocks} → ${measured}`);
    area.coverage.expectedPublicBlocks = measured;
    return true;
  });
  if (restated.length) writeJson(AREAS_PATH, areas);

  const total = [...excludedByArea.values()].reduce((sum, count) => sum + count, 0);
  console.log(`Excluded ${total} block(s) outside the City and County of Denver across ${excludedByArea.size} area(s).`);
  console.log("Next: npm run sync:coverage, then npm run audit:inventory.");
}

main();
