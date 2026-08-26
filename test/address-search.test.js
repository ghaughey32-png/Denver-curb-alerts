"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CurbGeometry = require("../public/curb-geometry.js");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");
const INVENTORY_PATH = path.join(__dirname, "..", "public", "denver-west-routes.json");

// Like test/curb-geometry.test.js, this reads public/app.js as source text.
// There is no bundler and no module boundary around the client, so the only way
// to exercise the address matcher is to lift it out and run it over the real
// published inventory. Renaming these functions will break this test even when
// behavior is unchanged; update the markers alongside the code.
function extractFunctionBlock(lines, startPattern) {
  const start = lines.findIndex((line) => startPattern.test(line));
  assert.ok(start >= 0, `could not find ${startPattern} in public/app.js`);

  let end = start;
  while (end < lines.length && lines[end] !== "}") {
    end += 1;
  }
  assert.ok(end < lines.length, `could not find the end of ${startPattern}`);

  return lines.slice(start, end + 1).join("\n");
}

function loadAddressSearch() {
  const lines = fs.readFileSync(APP_PATH, "utf8").split("\n");
  const searchStart = lines.findIndex((line) => /^const SEARCH_DIRECTION_LETTERS = \{/.test(line));
  assert.ok(searchStart >= 0, "could not find the address search section in public/app.js");

  const searchEnd = lines.findIndex(
    (line, index) => index > searchStart && /^function findLocalSearchMatch\(query\) \{/.test(line)
  );
  let close = searchEnd;
  while (lines[close] !== "}") {
    close += 1;
  }

  const source = [
    extractFunctionBlock(lines, /^function getPathCenter\(geometry\) \{/),
    lines.slice(searchStart, close + 1).join("\n")
  ].join("\n");

  const routes = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8")).routes || [];
  const streetWays = routes
    .filter((route) => Array.isArray(route.map && route.map.path) && route.map.path.length >= 2)
    .map((route) => ({
      name: route.streetName || `${route.from || ""} to ${route.to || ""}`.trim() || "Denver route",
      geometry: route.map.path,
      orientation: CurbGeometry.getStreetOrientation(route.map.path)
    }));

  const sandbox = { state: { streetWays }, buildEmbeddedDataset: () => ({ streetWays }) };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

const search = loadAddressSearch();

const METRES_PER_DEGREE_LATITUDE = 111320;
const METRES_PER_DEGREE_LONGITUDE = 85570;

function metresApart(match, [lat, lon]) {
  return Math.hypot(
    (match.lat - lat) * METRES_PER_DEGREE_LATITUDE,
    (match.lon - lon) * METRES_PER_DEGREE_LONGITUDE
  );
}

test("places a house number on its own block instead of the middle of the street", () => {
  // 3235 Larimer belongs between the 32nd and 33rd crossings. Denver's own
  // record for that block (unavailable-larimer-32nd-st) centers here. Before
  // the matcher understood house numbers it answered 39.760234,-104.983176 —
  // the centroid of every published Larimer vertex, four blocks southwest.
  const match = search.findLocalSearchMatch("3235 larimer st 80205");

  assert.ok(match, "3235 larimer st 80205 should match");
  assert.strictEqual(match.kind, "address");
  assert.strictEqual(match.matchedStreet, "LARIMER ST");
  assert.strictEqual(match.crossStreet, "32ND ST");
  assert.ok(
    metresApart(match, [39.764639, -104.977501]) < 130,
    `expected the 3200 block of Larimer, got ${match.lat},${match.lon}`
  );
});

test("a house number is placed on other numbered-grid streets too", () => {
  const cases = [
    ["2950 larimer st", [39.761818, -104.981123], "29TH ST"],
    ["4400 tennyson st", [39.7766, -105.0439], "W 44TH AVE"],
    ["1437 bannock st", [39.739, -104.9903], "W 14TH AVE"]
  ];

  for (const [query, expected, crossStreet] of cases) {
    const match = search.findLocalSearchMatch(query);
    assert.ok(match, `${query} should match`);
    assert.strictEqual(match.kind, "address", `${query} should resolve to an address`);
    assert.strictEqual(match.crossStreet, crossStreet);
    assert.ok(
      metresApart(match, expected) < 150,
      `${query} landed at ${match.lat},${match.lon}, ${metresApart(match, expected).toFixed(0)}m away`
    );
  }
});

test("a house number never matches a numbered street that merely shares its digits", () => {
  // "3235" used to satisfy the key "35" and pull in 35TH ST, and the "17" of
  // "e 17th ave" used to satisfy the key "7" and pull in E 7TH AVE.
  const larimer = search.findLocalSearchMatch("3235 larimer st 80205");
  assert.ok(!/35TH/.test(larimer.matchedStreet), "35TH ST must not enter the match");

  const seventeenth = search.findLocalSearchMatch("1234 e 17th ave");
  assert.ok(seventeenth, "1234 e 17th ave should match");
  assert.ok(!/7TH AVE/.test(seventeenth.matchedStreet.replace("17TH AVE", "")), "E 7TH AVE must not enter the match");
  assert.strictEqual(seventeenth.matchedStreet, "E 17TH AVE");
});

test("a cross-street query resolves to a corner the two streets actually share", () => {
  // The README's standing example: this used to pair W Iowa Ave with N Bellaire
  // St, two streets that never meet, by taking the latitude of one and the
  // longitude of the other.
  const match = search.findLocalSearchMatch("Iowa and Bellaire");

  assert.ok(match, "Iowa and Bellaire should match");
  assert.strictEqual(match.kind, "crossing");
  assert.strictEqual(match.matchedStreet, "E IOWA AVE and S BELLAIRE ST");
  assert.ok(
    metresApart(match, [39.6875, -104.9372]) < 150,
    `expected the E Iowa / S Bellaire corner, got ${match.lat},${match.lon}`
  );
});

test("a diagonal street cannot cross itself", () => {
  // Larimer runs at 45 degrees, so its blocks register as both east-west and
  // north-south. The old matcher paired it with itself as "LARIMER ST and
  // LARIMER ST" and answered with the whole street's centroid.
  const match = search.findLocalSearchMatch("larimer st");

  assert.ok(match, "larimer st should match");
  assert.strictEqual(match.kind, "street");
  assert.strictEqual(match.matchedStreet, "LARIMER ST");
});

test("a typed quadrant picks the right side of the grid", () => {
  const north = search.findLocalSearchMatch("N Bellaire St");
  const south = search.findLocalSearchMatch("S Bellaire St");

  assert.strictEqual(north.matchedStreet, "N BELLAIRE ST");
  assert.strictEqual(south.matchedStreet, "S BELLAIRE ST");
  assert.ok(north.lat > south.lat, "N Bellaire should sit north of S Bellaire");
});

test("a street with no placeable number is reported as a street match, not an address", () => {
  // Denver numbers east-west avenues off the named north-south grid, which the
  // inventory cannot resolve. Saying so is the point: the caller widens the map
  // and tells the user it only matched the street.
  const match = search.findLocalSearchMatch("1234 e 17th ave");
  assert.strictEqual(match.kind, "street");
});

test("an unknown street matches nothing", () => {
  assert.strictEqual(search.findLocalSearchMatch("nowhere road"), null);
});
