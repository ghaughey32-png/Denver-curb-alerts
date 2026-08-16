const test = require("node:test");
const assert = require("node:assert/strict");
const { auditInventory, normalizeStreetName } = require("../scripts/lib/inventory-auditor.js");

const block = {
  id: "example-main-a-b",
  streetName: "W MAIN ST",
  from: "A ST",
  to: "B ST",
  geometry: [[39.75, -105.01], [39.75, -105.00]]
};

test("normalizes common road-name variants before matching", () => {
  assert.equal(normalizeStreetName("West Main Street"), normalizeStreetName("W MAIN ST"));
  assert.equal(normalizeStreetName("Quitman Street"), normalizeStreetName("N Quitman St"));
  assert.equal(normalizeStreetName("South Irving Street Parkway"), normalizeStreetName("S Irving St"));
  assert.equal(normalizeStreetName("South Julian Circle"), normalizeStreetName("S Julian Cir"));
});

test("classifies an expected block as scheduled when official geometry covers it", () => {
  const routes = [{
    id: 1,
    streetName: "West Main Street",
    leftSweepingRule: "First Tuesday",
    map: { path: [[39.75, -105.011], [39.75, -104.999]] }
  }];
  const result = auditInventory({ routes, blocks: [block] });
  assert.equal(result.report.blocks[0].status, "scheduled");
  assert.equal(result.generatedRoutes.length, 0);
});

test("generates explicit verification coverage when Denver has no usable schedule", () => {
  const result = auditInventory({ routes: [], blocks: [block] });
  assert.equal(result.report.blocks[0].status, "unavailable");
  assert.equal(result.generatedRoutes.length, 1);
  assert.equal(result.generatedRoutes[0].dataUnavailable, true);
  assert.equal(result.generatedRoutes[0].expectedBlockId, block.id);
});

test("reports invalid public-road definitions as build-failing gaps", () => {
  const result = auditInventory({ routes: [], blocks: [{ id: "broken", streetName: "MAIN ST" }] });
  assert.equal(result.unexplainedGaps.length, 1);
  assert.equal(result.report.counts["unexplained-gap"], 1);
});

test("keeps excluded roads out of expected public-block totals", () => {
  const result = auditInventory({ routes: [], blocks: [{ ...block, excluded: true, exclusionReason: "private drive" }] });
  assert.equal(result.report.counts.expected, 0);
  assert.equal(result.report.counts.excluded, 1);
});
