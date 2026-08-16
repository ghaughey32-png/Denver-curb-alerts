const test = require("node:test");
const assert = require("node:assert/strict");
const { pointAt, offsetPoint, addressQueries } = require("../scripts/map-area-approach-3.js");

test("Change 2 samples a geometry by traveled distance", () => {
  const path = [[39.7, -105.01], [39.7, -105.00], [39.71, -105.00]];
  const midpoint = pointAt(path, 0.5);
  assert.ok(midpoint[0] >= 39.7 && midpoint[0] <= 39.71);
  assert.ok(midpoint[1] >= -105.01 && midpoint[1] <= -105.00);
});

test("Change 2 creates nearby probes on opposite sides of a block", () => {
  const path = [[39.7, -105.01], [39.7, -105.00]];
  const left = offsetPoint(path, 0.5, -18);
  const right = offsetPoint(path, 0.5, 18);
  assert.ok(left[0] < 39.7);
  assert.ok(right[0] > 39.7);
  assert.ok(Math.abs(left[1] - right[1]) < 1e-9);
});

test("Change 2 builds intersection fallbacks only from named endpoints", () => {
  const block = {
    streetName: "S Navajo St",
    from: "W Cedar Ave / W Byers Pl",
    to: "OSM node 123",
    geometry: [[39.7, -105.01], [39.69, -105.01]]
  };
  assert.deepEqual(addressQueries(block), [
    "S Navajo St & W Cedar Ave, Denver, CO",
    "S Navajo St & W Byers Pl, Denver, CO"
  ]);
});
