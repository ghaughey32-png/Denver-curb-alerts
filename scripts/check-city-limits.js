// Audits our city line against Denver's own published boundary, and reports.
// It never writes to the manifest or the payload.
//
// Why this exists. Until 2026-08-25 public/app.js drew its "outside Denver" wash
// from a live fetch of Denver's ArcGIS boundary layer while the pipeline
// excluded blocks with the OpenStreetMap rings. That was a bug -- the two
// disagreed over 589 published routes -- and the fix was to make both sides read
// public/denver-city-limits.js. But the bug had a side effect worth keeping: two
// independent boundaries meant a divergence between them was visible on the map.
// Collapsing to one source removed the disagreement and the second opinion with
// it, and the very first deliberate comparison found 45 blocks of Glendale's own
// side streets published as pink -- "you do not need to move your car" over curb
// Glendale sweeps and tickets. That is the failure this script is here to catch
// the next time, deliberately and offline of the runtime.
//
// The right relationship between the two sources: Denver's layer is the better
// data and the wrong dependency. It is a network fetch, the import and audit
// scripts are deliberately offline, and swapping the pipeline onto it would
// reclassify thousands of published blocks against a boundary that is not the
// same thing as Denver's sweeping footprint anyway -- the sweeping API returns
// real schedules for N Sheridan Blvd, which that layer places outside the city.
// So: authoritative data for auditing, our own rings for deciding.
//
// This is the one script that talks to a city service that is not the sweeping
// API, so the AGENTS.md rule about going through /api/denver/sweeping does not
// apply -- that rule is about parsing and geometry extraction for route lookups,
// and there is no proxy for the boundary layer. The response is cached at
// data/denver-official-boundary.json so re-runs need no network at all.
//
//   npm run check:city-limits              # cached if present, else fetch
//   npm run check:city-limits -- --refresh # force a fetch
//
// Exits non-zero when it finds published curb outside Denver's own line, so it
// can be used as a gate. Everything else is reported for a human to judge.

const fs = require("fs");
const path = require("path");
const { isPointInsideDenver, metresOutsideDenver, BOUNDARY_BUFFER_METRES } = require("./lib/denver-city-limits.js");
const { auditInventory } = require("./lib/inventory-auditor.js");

const ROOT = path.join(__dirname, "..");
const CACHE_PATH = path.join(ROOT, "data", "denver-official-boundary.json");
const MANIFEST_PATH = path.join(ROOT, "data", "inventory-expected-blocks.json");
const PAYLOAD_PATH = path.join(ROOT, "public", "denver-west-routes.json");

// Layer 4, "Denver Boundary", City Engineer's Office: the jurisdictional
// boundary plus every enclave administered by somebody else.
const BOUNDARY_URL =
  "https://services7.arcgis.com/BRS1jOwmVPgFs2NE/ArcGIS/rest/services/Analyze_Traffic_Regina18_WFL1/FeatureServer/4/query" +
  "?where=1%3D1&outFields=OBJECTID&returnGeometry=true&outSR=4326&f=geojson";

const METRES_PER_DEGREE_LATITUDE = 111320;
const METRES_PER_DEGREE_LONGITUDE = 85700;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

async function loadOfficialBoundary({ refresh }) {
  if (!refresh && fs.existsSync(CACHE_PATH)) return readJson(CACHE_PATH);

  const response = await fetch(BOUNDARY_URL, { headers: { "User-Agent": "denver-curb-alerts/city-limits-audit" } });
  if (!response.ok) throw new Error(`Denver's boundary layer answered HTTP ${response.status}`);
  const geoJson = await response.json();
  if (!geoJson.features || !geoJson.features.length) throw new Error("Denver's boundary layer returned no features");

  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(geoJson)}\n`, "utf8");
  return geoJson;
}

// The city is the one feature carrying holes: an outer ring plus a cut-out for
// every enclave. The remaining features are those same enclaves as standalone
// polygons, which is how the layer describes what they are rather than merely
// that Denver stops there.
function readOfficialRings(geoJson) {
  const polygons = geoJson.features
    .map((feature) => feature.geometry)
    .filter((geometry) => geometry && geometry.type === "Polygon")
    .map((geometry) => geometry.coordinates.map((ring) => ring.map(([longitude, latitude]) => [latitude, longitude])));

  const city = polygons.reduce((widest, rings) => (rings.length > widest.length ? rings : widest), polygons[0]);
  return { outer: city[0], enclaves: city.slice(1) };
}

function pointInRing([latitude, longitude], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [currentLat, currentLon] = ring[index];
    const [previousLat, previousLon] = ring[previous];
    if (currentLat > latitude === previousLat > latitude) continue;
    const crossing = ((previousLon - currentLon) * (latitude - currentLat)) / (previousLat - currentLat) + currentLon;
    if (longitude < crossing) inside = !inside;
  }
  return inside;
}

function metresToSegment([latitude, longitude], [aLat, aLon], [bLat, bLon]) {
  const x = (longitude - aLon) * METRES_PER_DEGREE_LONGITUDE;
  const y = (latitude - aLat) * METRES_PER_DEGREE_LATITUDE;
  const dx = (bLon - aLon) * METRES_PER_DEGREE_LONGITUDE;
  const dy = (bLat - aLat) * METRES_PER_DEGREE_LATITUDE;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
  return Math.hypot(x - t * dx, y - t * dy);
}

// Bounding-box rejection first, the same trick metresToRings uses: the nearest
// piece of the line is usually hundreds of metres away and the rest kilometres.
function metresToRings(point, rings) {
  let nearest = Infinity;
  for (const ring of rings) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const current = ring[index];
      const prior = ring[previous];
      const latitudeGap = Math.max(Math.min(current[0], prior[0]) - point[0], point[0] - Math.max(current[0], prior[0]), 0);
      const longitudeGap = Math.max(Math.min(current[1], prior[1]) - point[1], point[1] - Math.max(current[1], prior[1]), 0);
      const lowerBound = Math.hypot(latitudeGap * METRES_PER_DEGREE_LATITUDE, longitudeGap * METRES_PER_DEGREE_LONGITUDE);
      if (lowerBound >= nearest) continue;
      nearest = Math.min(nearest, metresToSegment(point, current, prior));
    }
  }
  return nearest;
}

function summariseDivergence(ours, theirs) {
  const distances = ours.map((point) => metresToRings(point, [theirs])).sort((a, b) => a - b);
  const at = (fraction) => distances[Math.floor(fraction * (distances.length - 1))];
  return { median: at(0.5), p90: at(0.9), p99: at(0.99), max: distances[distances.length - 1] };
}

function main(geoJson) {
  const { outer, enclaves } = readOfficialRings(geoJson);
  const officialRings = [outer, ...enclaves];
  const insideOfficialDenver = (point) => pointInRing(point, outer) && !enclaves.some((ring) => pointInRing(point, ring));
  const wellOutsideOfficial = (point) => !insideOfficialDenver(point) && metresToRings(point, officialRings) > BOUNDARY_BUFFER_METRES;
  const majorityOutsideOfficial = (geometry) =>
    geometry.filter(wellOutsideOfficial).length * 2 > geometry.length;
  const majorityInsideEnclave = (geometry) =>
    geometry.filter((point) => enclaves.some((ring) => pointInRing(point, ring))).length * 2 > geometry.length;

  const manifest = readJson(MANIFEST_PATH);
  const payload = readJson(PAYLOAD_PATH);
  const { report } = auditInventory({ routes: payload.routes, blocks: manifest.blocks, generateUnavailable: false });
  const statusById = new Map(report.blocks.map((entry) => [entry.id, entry.status]));

  const published = [];
  const enclaveHits = [];
  const overExcluded = [];

  for (const block of manifest.blocks) {
    const geometry = block.geometry;
    if (!Array.isArray(geometry) || !geometry.length) continue;

    if (block.excluded) {
      // Only worth reporting for blocks we dropped as another city's: the alley
      // and private-drive exclusions have nothing to do with the boundary.
      if (!/Denver|Glendale/.test(block.exclusionReason || "")) continue;
      if (majorityOutsideOfficial(geometry) || majorityInsideEnclave(geometry)) continue;
      if (geometry.some((point) => !isPointInsideDenver(point))) continue;
      overExcluded.push(block);
      continue;
    }

    const status = statusById.get(block.id);
    if (majorityInsideEnclave(geometry)) enclaveHits.push({ block, status });
    else if (majorityOutsideOfficial(geometry)) published.push({ block, status });
  }

  const line = (label, value) => console.log(`  ${String(label).padEnd(52)}${value}`);
  const listing = (rows) => {
    const byStreet = new Map();
    for (const row of rows) {
      const key = `${row.block.streetName} [${row.status || "unclassified"}]`;
      byStreet.set(key, (byStreet.get(key) || 0) + 1);
    }
    [...byStreet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .forEach(([street, count]) => console.log(`      ${String(count).padStart(4)}  ${street}`));
  };

  console.log("Denver's own boundary layer vs. public/denver-city-limits.js\n");

  const { DENVER_CITY_LIMITS } = require("./lib/denver-city-limits.js");
  const divergence = summariseDivergence(DENVER_CITY_LIMITS[0], outer);
  console.log("Line agreement (our outer ring's vertices to their line)");
  line("median", `${divergence.median.toFixed(1)} m`);
  line("90th percentile", `${divergence.p90.toFixed(1)} m`);
  line("99th percentile", `${divergence.p99.toFixed(1)} m`);
  line("worst", `${divergence.max.toFixed(1)} m`);

  console.log("\nPublished blocks Denver's layer places inside an enclave");
  line("count", enclaveHits.length);
  if (enclaveHits.length) listing(enclaveHits);

  console.log("\nPublished blocks Denver's layer places outside the city");
  line("count", published.length);
  if (published.length) listing(published);

  console.log("\nExcluded blocks Denver's layer places inside the city");
  line("count", overExcluded.length);
  if (overExcluded.length) {
    const byStreet = new Map();
    for (const block of overExcluded) byStreet.set(block.streetName, (byStreet.get(block.streetName) || 0) + 1);
    [...byStreet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .forEach(([street, count]) => console.log(`      ${String(count).padStart(4)}  ${street}`));
  }

  // A block with a schedule is Denver's whatever a boundary says -- Denver
  // sweeps it. Only the ones Denver returned nothing for are worth acting on,
  // and a pink one is actively telling the user not to move their car.
  const actionable = [...enclaveHits, ...published].filter((row) => row.status !== "scheduled");
  console.log("");
  if (!actionable.length) {
    console.log("Nothing to act on: every divergence carries a Denver sweeping schedule.");
    return 0;
  }
  console.log(`${actionable.length} block(s) sit outside Denver's own line with no Denver schedule.`);
  console.log("Those are the ones worth acting on. `npm run sync:city-limits` applies the");
  console.log("geometric rules we hold; anything it leaves behind needs the ring itself looked at.");
  return 1;
}

const refresh = process.argv.includes("--refresh");
loadOfficialBoundary({ refresh })
  .then((geoJson) => process.exit(main(geoJson)))
  .catch((error) => {
    console.error(`Could not audit the city line: ${error.message}`);
    process.exit(2);
  });
