const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeStreetKey,
  classifyStripDays,
  resolvePublishedDays,
  buildSnowCurbs,
  carryForwardIds,
  checkAgainstTickets
} = require("../scripts/lib/minneapolis-snow.js");

// A made-up block of E 30th St: a centreline running east for about 160 m, and the city's strip for
// its north curb, reaching 14 m north of the line the way the real ones do.
const WEST = -93.27;
const EAST = -93.268;
const LAT = 44.98;
const STRIP_NORTH = LAT + 14 / 111320;

function centreline({ route = "N", name = "30TH ST E" } = {}) {
  return {
    attributes: { OBJECTID: 1, STREET_O_NAME: name, SNOW_EMERGENCY_ROUTE: route },
    geometry: { paths: [[[WEST, LAT], [EAST, LAT]]] }
  };
}

function northStrip(days) {
  return {
    attributes: { OBJECTID: 7, DAY1: days[0], DAY2: days[1], DAY3: days[2], WINTERRULES: 0 },
    geometry: {
      rings: [[[WEST + 0.00005, LAT], [EAST - 0.00005, LAT], [EAST - 0.00005, STRIP_NORTH], [WEST + 0.00005, STRIP_NORTH], [WEST + 0.00005, LAT]]]
    }
  };
}

function addresses(numbers, lat) {
  return numbers.map((number, index) => ({
    attributes: { AddrNum: number, StreetName: "30TH", StreetType: "ST", PostDir: "E" },
    geometry: { x: WEST + 0.0003 + index * 0.0003, y: lat }
  }));
}

const northEven = addresses([100, 104, 108, 112], LAT + 0.0003);
const southOdd = addresses([101, 105, 109], LAT - 0.0003);

test("street names from both city datasets normalise to the same key", () => {
  assert.equal(normalizeStreetKey("Oak Grove Terr"), "OAK GROVE TER");
  assert.equal(normalizeStreetKey("spruce place"), "SPRUCE PL");
  assert.equal(normalizeStreetKey(" 30th  St E "), "30TH ST E");
});

test("a strip's day flags read as route, even side, odd side or other", () => {
  assert.equal(classifyStripDays([0, 1, 1]), "route");
  assert.equal(classifyStripDays([1, 0, 1]), "even");
  assert.equal(classifyStripDays([1, 1, 0]), "odd");
  assert.equal(classifyStripDays([1, 0, 0]), "other");
});

test("where the city's sources disagree, the stricter rule is published", () => {
  // The polygon says route (fine on days 2 and 3); the centreline says not a route. Tickets side with
  // the centreline, so the curb also loses its even/odd day.
  assert.deepEqual(resolvePublishedDays({ days: [0, 1, 1], centrelineRoute: "N", parity: "even" }).published, [0, 0, 1]);
  assert.deepEqual(resolvePublishedDays({ days: [0, 1, 1], centrelineRoute: "N", parity: "odd" }).published, [0, 1, 0]);
  // With no house numbers to say which side it is, both days go.
  assert.deepEqual(resolvePublishedDays({ days: [0, 1, 1], centrelineRoute: "N", parity: null }).published, [0, 0, 0]);
  // The centreline says route and the polygon does not: day 1 goes too.
  assert.deepEqual(resolvePublishedDays({ days: [1, 0, 1], centrelineRoute: "Y", parity: "even" }).published, [0, 0, 1]);
  // Even per the polygon, odd per the house numbers: neither day is safe.
  const mismatch = resolvePublishedDays({ days: [1, 0, 1], centrelineRoute: "N", parity: "odd" });
  assert.deepEqual(mismatch.published, [1, 0, 0]);
  assert.deepEqual(mismatch.conflicts, ["parity-mismatch"]);
  // Agreement changes nothing, and an unknown centreline flag is not a disagreement.
  assert.deepEqual(resolvePublishedDays({ days: [1, 0, 1], centrelineRoute: "N", parity: "even" }), {
    published: [1, 0, 1],
    conflicts: [],
    stripClass: "even"
  });
  assert.deepEqual(resolvePublishedDays({ days: [0, 1, 1], centrelineRoute: null, parity: null }).conflicts, []);
});

test("a strip becomes one curb on the right side of its named street", () => {
  const { curbs, report } = buildSnowCurbs({
    strips: [northStrip([1, 0, 1])],
    centrelineFeatures: [centreline()],
    addressFeatures: [...northEven, ...southOdd]
  });
  assert.equal(curbs.length, 1);
  const [curb] = curbs;
  assert.equal(curb.street, "30TH ST E");
  assert.equal(curb.sideKey, "north");
  assert.equal(curb.parity, "even");
  assert.deepEqual(curb.days, [1, 0, 1]);
  assert.deepEqual(curb.conflicts, []);
  assert.match(curb.id, /^mpls:[0-9a-f]{10}$/);
  // Drawn 4 m north of the centreline, like Denver's curbs.
  curb.geometry.forEach(([lat]) => assert.ok(Math.abs((lat - LAT) * 111320 - 4) < 0.5, `curb at ${lat}`));
  assert.equal(report.parity.even, 1);
});

test("a route strip on a street the centreline says is not a route is made stricter", () => {
  const { curbs, report } = buildSnowCurbs({
    strips: [northStrip([0, 1, 1])],
    centrelineFeatures: [centreline({ route: "N" })],
    addressFeatures: northEven
  });
  assert.deepEqual(curbs[0].days, [0, 0, 1]);
  assert.deepEqual(curbs[0].cityDays, [0, 1, 1]);
  assert.deepEqual(report.conflicts, { "route-not-in-centreline": 1 });
});

test("a refreshed curb keeps its id, so saved curbs and watching phones survive the season", () => {
  const first = buildSnowCurbs({ strips: [northStrip([1, 0, 1])], centrelineFeatures: [centreline()], addressFeatures: northEven });
  const previous = first.curbs;
  const nudged = previous.map((curb) => ({ ...curb, geometry: curb.geometry.map(([lat, lon]) => [lat + 0.00003, lon]) }));
  const kept = carryForwardIds(nudged, previous);
  assert.equal(kept.curbs[0].id, previous[0].id);
  assert.deepEqual(kept.retired, []);

  const moved = previous.map((curb) => ({ ...curb, geometry: curb.geometry.map(([lat, lon]) => [lat + 0.001, lon]) }));
  const replaced = carryForwardIds(moved, previous);
  assert.notEqual(replaced.curbs[0].id, previous[0].id);
  assert.deepEqual(replaced.retired, [previous[0].id]);
});

test("the ticket check scores precise tickets and sets aside the city's stand-in points", () => {
  const curbs = [{ days: [1, 0, 1], geometry: [[LAT + 0.00004, WEST], [LAT + 0.00004, EAST]] }];
  const onCurb = { Latitude: LAT + 0.00004, Longitude: -93.269 };
  const tickets = [
    { Day: 2, Address: "104 30TH ST E", ...onCurb },
    { Day: 3, Address: "108 30TH ST E", Latitude: LAT + 0.00004, Longitude: -93.2689 },
    { Day: 1, Address: "1 ELSEWHERE", Latitude: 45.1, Longitude: -93.1 },
    { Day: 2, Address: "0 NOWHERE", Latitude: 0, Longitude: 0 },
    // Three different addresses at one identical point: the city's fallback, not a location.
    ...["1 A ST", "3 A ST", "5 A ST"].map((Address) => ({ Day: 3, Address, Latitude: LAT, Longitude: -93.2685 }))
  ];
  const result = checkAgainstTickets(curbs, tickets);
  assert.deepEqual(result.byDay[2], { tickets: 1, explained: 1, contradicted: 0, noCurb: 0 });
  assert.deepEqual(result.byDay[3], { tickets: 1, explained: 0, contradicted: 1, noCurb: 0 });
  assert.deepEqual(result.byDay[1], { tickets: 1, explained: 0, contradicted: 0, noCurb: 1 });
  assert.equal(result.sharedLocation, 3);
  assert.equal(result.missingCoordinates, 1);
});
