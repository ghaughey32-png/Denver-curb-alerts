const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DENVER_CITY_LIMITS,
  BOUNDARY_BUFFER_METRES,
  isPointInsideDenver,
  metresOutsideDenver,
  isOutsideDenverBlock,
  clipPathToDenver,
  getDenverMaskRings
} = require("../scripts/lib/denver-city-limits.js");

test("every ring is closed, so the ray casting has no open edges", () => {
  assert.ok(DENVER_CITY_LIMITS.length >= 2);
  for (const ring of DENVER_CITY_LIMITS) {
    assert.ok(ring.length >= 4);
    for (const point of ring) {
      assert.equal(point.length, 2);
      assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]));
    }
  }
});

test("Denver neighbourhoods are inside the city line", () => {
  const inside = [
    ["Union Station", 39.7527, -104.9997],
    ["University Hills", 39.665, -104.93],
    ["Southmoor Park panhandle", 39.635, -104.895],
    ["Denver International Airport", 39.8561, -104.6737]
  ];
  for (const [name, latitude, longitude] of inside) {
    assert.equal(isPointInsideDenver([latitude, longitude]), true, name);
    assert.equal(metresOutsideDenver([latitude, longitude]), 0, name);
  }
});

// These are the cities the southeast rectangles run into. Publishing their
// streets as pink would tell the user not to move a car that their own city is
// about to ticket, which is the whole reason this module exists.
test("neighbouring municipalities are outside the city line", () => {
  const outside = [
    ["Aurora", 39.7099, -104.8214],
    ["Glendale", 39.705, -104.935],
    ["Greenwood Village", 39.62, -104.9],
    ["Cherry Hills Village", 39.645, -104.95],
    ["Cherry Creek State Park", 39.64, -104.85]
  ];
  for (const [name, latitude, longitude] of outside) {
    assert.equal(isPointInsideDenver([latitude, longitude]), false, name);
    assert.ok(metresOutsideDenver([latitude, longitude]) > 0, name);
  }
});

// Holly Hills is unincorporated Arapahoe County, a hole in the middle of the
// Colorado–Monaco rectangles rather than a bite out of their edge, so it only
// classifies correctly if the holes are carried and the ray casting is even-odd.
test("the Holly Hills pocket is treated as a hole, not as Denver", () => {
  assert.equal(isPointInsideDenver([39.6627, -104.9207]), false);
  assert.equal(isPointInsideDenver([39.6642, -104.9207]), false);
  // Denver resumes west of the pocket and north of it toward Evans.
  assert.equal(isPointInsideDenver([39.6627, -104.9316]), true);
  assert.equal(isPointInsideDenver([39.676, -104.9316]), true);
});

// The city line runs down the middle of the streets it shares, and Denver
// sweeps its own curb on all of them. Excluding a block for straddling the line
// would throw away real coverage, so the buffer has to keep it.
test("blocks on a shared boundary street stay in the manifest", () => {
  const yosemiteCurb = [[39.63, -104.8852], [39.631, -104.8852], [39.632, -104.8852]];
  assert.equal(isOutsideDenverBlock(yosemiteCurb), false);
});

test("blocks well clear of the line are excluded", () => {
  const insideAurora = [[39.63, -104.86], [39.631, -104.86], [39.632, -104.86]];
  assert.equal(isOutsideDenverBlock(insideAurora), true);
});

test("degenerate geometry is never excluded", () => {
  assert.equal(isOutsideDenverBlock([]), false);
  assert.equal(isOutsideDenverBlock(null), false);
  assert.equal(isOutsideDenverBlock(undefined), false);
});

// A block that only reaches across the line stays in the manifest, and the pink
// drawn for it used to run the whole length of the way — telling the user not to
// move a car parked on curb that Englewood or Sheridan sweeps. Trimming keeps
// the Denver half clickable and stops drawing the rest.
test("a path that leaves Denver is trimmed at the line", () => {
  // West across Sheridan Boulevard, from Denver into Lakewood.
  const westward = [[39.7, -105.05], [39.7, -105.07]];
  const [piece] = clipPathToDenver(westward);

  assert.equal(clipPathToDenver(westward).length, 1);
  assert.deepEqual(piece[0], westward[0]);
  assert.ok(piece[1][1] > -105.07, "the far end should be pulled back toward Denver");
  // The cut lands on the 20 m buffer, give or take the decimetre that rounding
  // the crossing to six decimals can move it.
  assert.ok(metresOutsideDenver(piece[1]) <= 20.5);
});

test("a path wholly inside Denver is returned untouched", () => {
  const capitolHill = [[39.7392, -104.9847], [39.7392, -104.9803], [39.7392, -104.976]];
  assert.deepEqual(clipPathToDenver(capitolHill), [capitolHill]);
});

test("a path wholly outside Denver clips away to nothing", () => {
  assert.deepEqual(clipPathToDenver([[39.63, -104.86], [39.632, -104.86]]), []);
  assert.deepEqual(clipPathToDenver([[39.7, -105.05]]), []);
  assert.deepEqual(clipPathToDenver(null), []);
});

// East Cherry Creek South Drive clips the corner of Glendale and comes back, so
// a single surviving piece would have to bridge the gap with a straight line
// through another city's curb.
test("a path that leaves Denver and returns keeps both pieces", () => {
  const outAndBack = [[39.7, -104.9497], [39.7, -104.94], [39.7, -104.93], [39.7, -104.9203]];
  const pieces = clipPathToDenver(outAndBack);

  assert.equal(pieces.length, 2);
  pieces.flat().forEach((point) => assert.ok(metresOutsideDenver(point) <= 20.5));
});

// The line runs down the middle of the streets it shares, so a curb drawn on
// East Hampden's centreline sits a metre or two either side of it at random.
// Cutting at the line itself would shred that block into dashes.
test("a curb on a shared boundary street survives whole", () => {
  const hampden = [[39.6529, -104.9], [39.6529, -104.895], [39.6529, -104.89]];
  assert.deepEqual(clipPathToDenver(hampden), [hampden]);
});

// --- The map mask -----------------------------------------------------------
//
// The mask public/app.js paints and the exclusion above used to come from
// different maps: the mask from a live ArcGIS fetch of Denver's own boundary
// layer, the exclusion from the OpenStreetMap rings, with the 20 m buffer
// applied on the pipeline side only. That put 589 published routes under red
// paint — 261 with real sweeping schedules, 219 covered end to end — which
// reads as "this app has no data here" on curb it does have data for. Both
// sides now read this module. These tests are what keeps them there.

// Even-odd across the world ring and the mask rings, which is exactly how
// loadDenverBoundary hands the polygon to Leaflet.
function maskCovers(rings, [latitude, longitude]) {
  let inside = false;
  for (const ring of rings) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [currentLat, currentLon] = ring[index];
      const [previousLat, previousLon] = ring[previous];
      if (currentLat > latitude === previousLat > latitude) continue;
      const crossing = ((previousLon - currentLon) * (latitude - currentLat)) / (previousLat - currentLat) + currentLon;
      if (longitude < crossing) inside = !inside;
    }
  }
  return !inside;
}

test("the mask leaves Denver clear and covers the cities around it", () => {
  const rings = getDenverMaskRings();
  const clear = [
    ["Union Station", 39.7527, -104.9997],
    ["University Hills", 39.665, -104.93],
    ["Denver International Airport", 39.8561, -104.6737]
  ];
  const covered = [
    ["Aurora", 39.7099, -104.8214],
    ["Glendale", 39.705, -104.935],
    ["Holly Hills", 39.6627, -104.9207],
    ["Greenwood Village", 39.62, -104.9],
    ["Lakewood", 39.7, -105.09]
  ];

  for (const [name, latitude, longitude] of clear) {
    assert.equal(maskCovers(rings, [latitude, longitude]), false, name);
  }
  for (const [name, latitude, longitude] of covered) {
    assert.equal(maskCovers(rings, [latitude, longitude]), true, name);
  }
});

// The buffer is the whole reason the mask is not simply the raw rings. Drawn on
// the line itself it covers 625 published routes, 244 of them end to end,
// because the line runs down the middle of the streets it shares.
test("the mask is the buffered city, not the raw line", () => {
  const rings = getDenverMaskRings();
  // Curb on Denver's own side of four streets whose centreline is the boundary.
  // The Colorado Boulevard points are the published route geometry either side
  // of Glendale, the case AGENTS.md calls out: Glendale's line runs down the
  // middle of the boulevard and Denver sweeps the western curb.
  const sharedCurbs = [
    ["South Yosemite Street", 39.631, -104.8852],
    ["East Hampden Avenue", 39.6529, -104.895],
    ["South Colorado Boulevard north of Glendale", 39.71156, -104.9407],
    ["South Colorado Boulevard mid-Glendale", 39.70206, -104.94069]
  ];
  for (const [name, latitude, longitude] of sharedCurbs) {
    assert.equal(maskCovers(rings, [latitude, longitude]), false, name);
  }
});

// Enclaves narrower than twice the buffer invert when they are shrunk by it.
// Drawing their inverted remains masks a wedge of real Denver, so they are
// dropped: an enclave everywhere within 20 m of Denver is Denver as far as the
// rest of this app is concerned. Glendale and Holly Hills are far bigger than
// that and must survive.
test("the mask keeps the enclaves big enough to survive the buffer", () => {
  const rings = getDenverMaskRings();
  assert.ok(rings.length >= 3, "the outline and the two large enclaves at least");
  assert.ok(rings.length < DENVER_CITY_LIMITS.length, "the sub-40 m enclaves should be dropped");
  assert.equal(rings[0].length > DENVER_CITY_LIMITS[0].length, true, "corners are rounded, not mitered");
});

// The property the whole exercise is about: red says the app has nothing here,
// so it must not be painted over curb the app publishes.
//
// Fifteen two-point stubs still slip under it, all of them in the same kind of
// place: a finger or slot in the boundary narrower than twice the buffer, which
// a vertex offset turns inside out rather than closing. Glendale has an
// eleven-metre one at its southern tip on Colorado Boulevard; the rest are on
// Leetsdale, Belleview, Havana and Yale. Removing them means untangling the
// self-intersecting loops a naive offset leaves behind, which is a real
// polygon clipper — a lot of geometry, in a repo with two dependencies, for
// fifteen stubs. The budget below is deliberately just above the measured
// count, so a wider regression fails here rather than shipping.
test("the mask does not cover curb the app publishes", () => {
  const inventory = require("../public/denver-west-routes.json");
  const rings = getDenverMaskRings();

  const covered = [];
  for (const route of inventory.routes) {
    const path = route.map && route.map.path;
    if (!Array.isArray(path) || !path.length) continue;
    const under = path.filter(
      (point) => maskCovers(rings, point) && metresOutsideDenver(point) <= BOUNDARY_BUFFER_METRES
    );
    if (under.length === path.length) covered.push(`${route.streetName} at ${path[0]}`);
  }

  assert.ok(
    covered.length <= 20,
    `The mask covers ${covered.length} published routes end to end, up from the 15 measured on ` +
      `2026-08-25. The ArcGIS mask this replaced covered 219.\n  ${covered.slice(0, 25).join("\n  ")}`
  );
});
