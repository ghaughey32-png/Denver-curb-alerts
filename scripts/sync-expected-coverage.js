const fs = require("fs/promises");
const path = require("path");
const { auditInventory } = require("./lib/inventory-auditor.js");

const ROOT = path.join(__dirname, "..");
const JSON_PATH = path.join(ROOT, "public", "denver-west-routes.json");
const SCRIPT_PATH = path.join(ROOT, "public", "denver-west-routes.js");
const MANIFEST_PATH = path.join(ROOT, "data", "inventory-expected-blocks.json");

async function main() {
  const [payload, manifest] = await Promise.all([
    fs.readFile(JSON_PATH, "utf8").then(JSON.parse),
    fs.readFile(MANIFEST_PATH, "utf8").then(JSON.parse)
  ]);
  const audit = auditInventory({ routes: payload.routes, blocks: manifest.blocks });
  const existingIds = new Set(payload.routes.map((route) => route.id));
  const additions = audit.generatedRoutes.filter((route) => !existingIds.has(route.id));
  payload.routes.push(...additions);
  payload.routeCount = payload.routes.length;
  await fs.writeFile(JSON_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.writeFile(SCRIPT_PATH, `window.DENVER_WEST_ROUTE_INVENTORY = ${JSON.stringify(payload)};\n`, "utf8");
  console.log(`Added ${additions.length} expected coverage routes.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
