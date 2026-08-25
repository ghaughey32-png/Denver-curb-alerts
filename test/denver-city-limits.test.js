const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DENVER_CITY_LIMITS,
  isPointInsideDenver,
  metresOutsideDenver,
  isOutsideDenverBlock,
  clipPathToDenver
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
