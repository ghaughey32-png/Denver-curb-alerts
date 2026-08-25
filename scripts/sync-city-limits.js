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
// in public/denver-city-limits.js is refined.
//
// It also asks a question the importer cannot. The enclave tests carry a 20 m
// buffer because an enclave's line runs down the middle of the streets ringing
// it -- Colorado Boulevard, South Cherry Street, East Mississippi Avenue around
// Glendale -- and Denver sweeps its own curb on all of them. That buffer is not
// caution, it is necessary: 29 blocks Denver returns real schedules for sit
// inside the Glendale ring at a median depth of 5.6 m, against 5.8 m for
// Glendale's own side streets. No threshold tells them apart.
//
// A sweeping schedule does. Running after the crawl, this script knows which
// blocks Denver answered for, so it can drop the buffer and ask the plain
// question of everything Denver returned nothing for. That found 45 blocks of
// Glendale's grid and 22 in the Holly Hills pocket published as pink on
// 2026-08-25 -- "you do not need to move your car" over curb those cities sweep
// and ticket. `npm run check:city-limits` is what surfaced them, and is worth
// running after this one to see what geometry alone still cannot settle.
//
// It does not touch the published payload. Run `npm run sync:coverage`
// afterwards: that regenerates every pink fallback from the manifest, which both
// withdraws the ones excluded here and trims the ones that merely reach across
// the line (see clipPathToDenver).

const fs = require("fs");
const path = require("path");
const {
  isOutsideDenverBlock,
  isInsideEnclaveUnbuffered,
  OUTSIDE_DENVER_EXCLUSION_REASON
} = require("./lib/denver-city-limits.js");
const { isInsideGlendaleUnbuffered, GLENDALE_EXCLUSION_REASON } = require("./lib/glendale-city-limits.js");
const { auditInventory } = require("./lib/inventory-auditor.js");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "data", "inventory-expected-blocks.json");
const AREAS_PATH = path.join(ROOT, "data", "coverage-pilot-areas.json");
const PAYLOAD_PATH = path.join(ROOT, "public", "denver-west-routes.json");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

// Which blocks did Denver actually give a sweeping schedule for? The importer
// cannot ask -- it runs before the crawl -- but this script runs after, and for
// the Glendale rule below that answer is the only thing that separates the
// enclave's own side streets from Denver's curb on the boulevards that ring it.
// The auditor is the canonical classifier, so use it rather than a second
// matching loop that could drift from it; generateUnavailable stays off because
// nothing here should publish anything.
function scheduledBlockIds(blocks) {
  if (!fs.existsSync(PAYLOAD_PATH)) return null;
  const payload = readJson(PAYLOAD_PATH);
  const { report } = auditInventory({ routes: payload.routes, blocks, generateUnavailable: false });
  return new Set(report.blocks.filter((entry) => entry.status === "scheduled").map((entry) => entry.id));
}

function main() {
  const manifest = readJson(MANIFEST_PATH);
  const excludedByArea = new Map();
  const count = (block) => {
    const area = String(block.id).replace(/-osm-.*$/, "");
    excludedByArea.set(area, (excludedByArea.get(area) || 0) + 1);
  };

  const scheduled = scheduledBlockIds(manifest.blocks);
  if (!scheduled) {
    console.log("No published payload; running the city-line pass only.");
  }
  let enclaved = 0;

  manifest.blocks = manifest.blocks.map((block) => {
    if (block.excluded) return block;

    if (isOutsideDenverBlock(block.geometry)) {
      count(block);
      return { ...block, excluded: true, exclusionReason: OUTSIDE_DENVER_EXCLUSION_REASON };
    }

    // The enclaves, without the buffer, for the blocks Denver returned nothing
    // for. Pink over another municipality's side streets is the worst answer
    // this app can give: it says "you do not need to move your car" on curb
    // Glendale sweeps and tickets. Excluding draws nothing there instead, which
    // is what the importer would have done had the buffer not had to be so
    // generous. Glendale carries its own finer ring, so ask it separately; the
    // rest -- the Holly Hills pocket and the three small ones -- come from the
    // holes in the city rings.
    if (scheduled && !scheduled.has(block.id)) {
      if (isInsideGlendaleUnbuffered(block.geometry)) {
        count(block);
        enclaved += 1;
        return { ...block, excluded: true, exclusionReason: GLENDALE_EXCLUSION_REASON };
      }
      if (isInsideEnclaveUnbuffered(block.geometry)) {
        count(block);
        enclaved += 1;
        return { ...block, excluded: true, exclusionReason: OUTSIDE_DENVER_EXCLUSION_REASON };
      }
    }

    return block;
  });

  if (!excludedByArea.size) {
    console.log("Every block in the manifest is already inside the city line; nothing to exclude.");
    return;
  }
  if (enclaved) console.log(`  ${enclaved} block(s) inside an enclave that Denver returned no schedule for`);

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

  const total = [...excludedByArea.values()].reduce((sum, n) => sum + n, 0);
  console.log(`Excluded ${total} block(s) that Denver does not sweep across ${excludedByArea.size} area(s).`);
  console.log("Next: npm run sync:coverage, then npm run audit:inventory.");
}

main();
