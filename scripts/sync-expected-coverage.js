const fs = require("fs/promises");
const path = require("path");
const { auditInventory } = require("./lib/inventory-auditor.js");
const { addConfirmedValverdeCoverage } = require("./lib/confirmed-valverde-coverage.js");
const { applyConfirmedVrainCoverage } = require("./lib/confirmed-vrain-coverage.js");
const { applyConfirmedRegisAreaCoverage } = require("./lib/confirmed-regis-area-coverage.js");

const ROOT = path.join(__dirname, "..");
const JSON_PATH = path.join(ROOT, "public", "denver-west-routes.json");
const SCRIPT_PATH = path.join(ROOT, "public", "denver-west-routes.js");
const MANIFEST_PATH = path.join(ROOT, "data", "inventory-expected-blocks.json");
const REPORT_PATH = path.join(ROOT, "data", "inventory-coverage-report.json");
const PUBLISHED_COVERAGE_PREFIXES = [
  "w5-alameda-federal-i25-osm-",
  "w5-bayaud-sheridan-federal-osm-",
  "bayaud-exposition-sheridan-federal-osm-",
  "nevada-exposition-federal-i25-osm-",
  "ohio-florida-sheridan-federal-osm-",
  "ohio-florida-federal-i25-osm-",
  "virginia-florida-jason-bannock-osm-",
  "florida-evans-sheridan-federal-osm-",
  "evans-yale-sheridan-federal-osm-",
  "yale-dartmouth-wadsworth-federal-osm-",
  "florida-yale-federal-i25-osm-",
  "w50-vrain-infill-osm-",
  "e17-e26-downing-york-osm-"
];
const PUBLISHED_COVERAGE_IDS = new Set([
  "west-regis-university-frontage",
  "west-parkside-decatur-eliot"
]);
const isPublishedCoverageBlock = (id) =>
  PUBLISHED_COVERAGE_IDS.has(String(id)) ||
  PUBLISHED_COVERAGE_PREFIXES.some((prefix) => String(id).startsWith(prefix));

async function main() {
  const [payload, manifest] = await Promise.all([
    fs.readFile(JSON_PATH, "utf8").then(JSON.parse),
    fs.readFile(MANIFEST_PATH, "utf8").then(JSON.parse)
  ]);
  // Rebuild generated expected-block routes on every sync so newly confirmed
  // schedules replace their former unavailable-data overlays immediately.
  payload.routes = payload.routes.filter((route) => !route.dataUnavailable || !route.expectedBlockId);
  const routeMap = new Map(payload.routes.map((route) => [route.id, route]));
  addConfirmedValverdeCoverage(routeMap);
  applyConfirmedVrainCoverage(routeMap);
  applyConfirmedRegisAreaCoverage(routeMap);
  payload.routes = Array.from(routeMap.values());
  const targetBlocks = manifest.blocks.filter((block) => isPublishedCoverageBlock(block.id));
  const targetAudit = auditInventory({ routes: payload.routes, blocks: targetBlocks });
  const existingIds = new Set(payload.routes.map((route) => route.id));
  // Keep every audited public-road block clickable. Generated routes are
  // explicitly marked unavailable, so they fill geometry gaps without
  // presenting an unverified sweeping schedule as official Denver data.
  const additions = targetAudit.generatedRoutes.filter((route) =>
    !existingIds.has(route.id) && isPublishedCoverageBlock(route.expectedBlockId)
  );
  payload.routes.push(...additions);
  const audit = auditInventory({ routes: payload.routes, blocks: manifest.blocks, generateUnavailable: false });
  payload.routeCount = payload.routes.length;
  payload.areaLabel = "Denver expanded: East 17th–East 26th from Downing–York, plus the West Denver and RiNo inventories";
  await fs.writeFile(JSON_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.writeFile(SCRIPT_PATH, `window.DENVER_WEST_ROUTE_INVENTORY = ${JSON.stringify(payload)};\n`, "utf8");
  await fs.writeFile(REPORT_PATH, `${JSON.stringify({
    ...audit.report,
    generatedAt: new Date().toISOString(),
    expectedBlockManifestVersion: manifest.version
  }, null, 2)}\n`, "utf8");
  console.log(`Added ${additions.length} expected coverage routes.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
