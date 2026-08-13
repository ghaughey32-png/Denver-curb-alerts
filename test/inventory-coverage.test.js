const test = require("node:test");
const assert = require("node:assert/strict");
const inventory = require("../public/denver-west-routes.json");
const manifest = require("../data/inventory-expected-blocks.json");
const { auditInventory } = require("../scripts/lib/inventory-auditor.js");

test("every declared public street block renders scheduled or explicit unavailable coverage", () => {
  const result = auditInventory({ routes: inventory.routes, blocks: manifest.blocks, generateUnavailable: false });
  assert.deepEqual(result.unexplainedGaps, []);
  assert.equal(result.report.counts.expected, manifest.blocks.filter((block) => !block.excluded).length);
});
