"use strict";

// Boston's city line (public/boston-city-limits.js): the wash must hold the neighbouring towns and leave
// every published curb alone, as Denver's, Minneapolis's and San Francisco's do.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Limits = require("../public/boston-city-limits.js");
const registry = require("../public/cities.js");
const INVENTORY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "boston-sweeping.json"), "utf8"));

function pointInside(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > point[0] !== yj > point[0] && point[1] < ((xj - xi) * (point[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

test("the city line holds Boston's neighbourhoods and not the towns around it", () => {
  const [ring] = Limits.CITY_LIMITS;
  assert.ok(pointInside([42.3601, -71.0589], ring), "downtown is inside");
  assert.ok(pointInside([42.3782, -71.0602], ring), "Charlestown is inside");
  assert.ok(pointInside([42.3702, -71.039], ring), "East Boston is inside");
  assert.ok(pointInside([42.2554, -71.1245], ring), "Hyde Park is inside");
  assert.ok(!pointInside([42.3736, -71.119], ring), "Cambridge is outside");
  assert.ok(!pointInside([42.3425, -71.1213], ring), "Brookline is outside");
  assert.ok(!pointInside([42.2529, -71.0023], ring), "Quincy is outside");
  assert.ok(!pointInside([42.3918, -71.0328], ring), "Chelsea is outside");
  assert.equal(Limits.BOUNDARY_BUFFER_METRES, 20);
  assert.equal(registry.getCityLimits(registry.getCity("boston")), Limits, "the record names this module");
});

test("the wash leaves every published curb alone", () => {
  const [mask] = Limits.getMaskRings();
  let under = 0;
  INVENTORY.curbs.forEach((curb) => curb.geometry.forEach((point) => {
    if (!pointInside(point, mask)) under += 1;
  }));
  assert.equal(under, 0, `${under} curb points sit under the red wash`);
});

test("the outline is cut from the ring, one path per stretch that meets land", () => {
  assert.ok(Limits.OUTLINE_PATHS.length > 5);
  Limits.OUTLINE_PATHS.forEach((pathPoints) => assert.ok(pathPoints.length >= 2));
});
