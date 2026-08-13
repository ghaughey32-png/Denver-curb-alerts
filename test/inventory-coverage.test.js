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

test("Tennyson has explicit curb coverage from W 46th through W 52nd", () => {
  const expectedIds = [
    "tennyson-46-47",
    "tennyson-47-48-south",
    "tennyson-48-south-48",
    "tennyson-48-49",
    "tennyson-49-50",
    "tennyson-50-51",
    "tennyson-51-52"
  ];
  const routesByExpectedBlock = new Map(
    inventory.routes
      .filter((route) => route.streetName === "N TENNYSON ST" && route.expectedBlockId)
      .map((route) => [route.expectedBlockId, route])
  );

  assert.deepEqual(expectedIds.filter((id) => !routesByExpectedBlock.has(id)), []);
  expectedIds.forEach((id) => {
    const route = routesByExpectedBlock.get(id);
    assert.equal(route.dataUnavailable, true);
    assert.equal(route.map.path.length, 2);
  });
});
