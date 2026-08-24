const EARTH_RADIUS_METERS = 6371000;
// Denver sits near 39.7°N, where a degree of longitude spans about 85.6 km and a
// degree of latitude about 111.1 km. The bounding-box rejection below divides by
// slightly smaller figures on purpose: a smaller denominator pads the box out a
// little further than the tolerance strictly requires, so the shortcut can only
// ever be too cautious, never too eager.
const METERS_PER_DEGREE_LATITUDE = 110000;
const METERS_PER_DEGREE_LONGITUDE = 85000;

// auditInventory asks for the normalized form of every route's street name once
// per block it classifies, which on a city-wide run means tens of millions of
// passes through the replacement chain below. The set of distinct street names
// is tiny by comparison, so memoizing collapses that work to one pass per name.
const normalizedStreetNames = new Map();

function normalizeStreetName(value = "") {
  const original = String(value);
  const memoized = normalizedStreetNames.get(original);
  if (memoized !== undefined) return memoized;

  const normalized = original
    .toUpperCase()
    .replace(/\bWEST\b/g, "W")
    .replace(/\bEAST\b/g, "E")
    .replace(/\bNORTH\b/g, "N")
    .replace(/\bSOUTH\b/g, "S")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bPLACE\b/g, "PL")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/\bCIRCLE\b/g, "CIR")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bDRIVE\b/g, "DR")
    // Denver includes PARKWAY in E 26th Avenue's route name while OSM labels
    // the same continuous roadway East 26th Avenue.
    .replace(/\bAVE (?:PARKWAY|PKWY)\b/g, "AVE")
    // Same shape one street over: Denver calls the diagonal connector between
    // E 31st Ave and MLK at Elizabeth "E 31ST AVENUE DR", while OSM labels it
    // plain "East 31st Avenue". It is the only AVENUE DR in Denver's route
    // names and the manifest never uses the suffix at all, so folding it away
    // costs nothing. The Drive branches off the Avenue and touches it at the
    // junction, but a block only matches when 90% of its samples fall within
    // the tolerance, so geometry still keeps the two roadways apart.
    .replace(/\bAVE (?:DR|DRIVE)\b/g, "AVE")
    // Denver calls this roadway S Irving St while the public-road inventory
    // calls the same divided carriageway South Irving Street Parkway.
    .replace(/\bIRVING ST PARKWAY\b/g, "IRVING ST")
    // Denver abbreviates PARKWAY to PKWY in route names (e.g. "S MARION
    // STREET PKWY") while the OSM-derived expected-block manifest spells it
    // out in full ("South Marion Street Parkway"). Normalize both to PKWY so
    // divided parkways like Marion and Downing match their Denver routes.
    .replace(/\bPARKWAY\b/g, "PKWY")
    // OSM splits the divided stretch of Buchtel between Broadway and University
    // into separate "East Buchtel North Boulevard" and "East Buchtel South
    // Boulevard" carriageways, but Denver names both roadways E BUCHTEL BLVD and
    // tells them apart only by geometry — each carriageway gets its own route
    // with its own sweeping day. Drop the infix so the geometric match decides
    // which carriageway a route covers.
    .replace(/\bBUCHTEL [NS] BLVD\b/g, "BUCHTEL BLVD")
    // Denver spells this boulevard both ways in its own route names -- most
    // records say E MARTIN LUTHER KING BLVD, some say E MARTIN LUTHER KING JR
    // BLVD -- while the OSM-derived manifest always carries the honorific. The
    // index is keyed by name, so without this the manifest's blocks never get
    // compared against Denver's routes at all and every one of them publishes a
    // pink fallback directly on top of a scheduled route. Drop the honorific and
    // let the geometric match decide, the same way BUCHTEL does above.
    .replace(/\bMARTIN LUTHER KING JR\b/g, "MARTIN LUTHER KING")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/^[NSEW] /, "");

  normalizedStreetNames.set(original, normalized);
  return normalized;
}

function distanceMeters(a, b) {
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

function distanceToSegmentMeters(point, start, end) {
  const meanLat = ((point[0] + start[0] + end[0]) / 3) * Math.PI / 180;
  const scaleX = Math.cos(meanLat) * Math.PI * EARTH_RADIUS_METERS / 180;
  const scaleY = Math.PI * EARTH_RADIUS_METERS / 180;
  const px = point[1] * scaleX;
  const py = point[0] * scaleY;
  const ax = start[1] * scaleX;
  const ay = start[0] * scaleY;
  const bx = end[1] * scaleX;
  const by = end[0] * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToPathMeters(point, path) {
  if (!Array.isArray(path) || path.length < 2) return Infinity;
  let minimum = Infinity;
  for (let index = 1; index < path.length; index += 1) {
    minimum = Math.min(minimum, distanceToSegmentMeters(point, path[index - 1], path[index]));
  }
  return minimum;
}

function pathBounds(path) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  if (!Array.isArray(path)) return { minLat, maxLat, minLon, maxLon };
  for (const [lat, lon] of path) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

// A sample point lying outside a route's bounding box by more than the match
// tolerance cannot possibly be within the tolerance of the route itself, so this
// skips the per-segment walk for the many same-named routes that run nowhere
// near the block being classified. Routes with fewer than two points collapse to
// an empty box and are rejected here, which matches distanceToPathMeters
// returning Infinity for them.
function beyondBounds(point, bounds, toleranceMeters) {
  const latitudePad = toleranceMeters / METERS_PER_DEGREE_LATITUDE;
  const longitudePad = toleranceMeters / METERS_PER_DEGREE_LONGITUDE;
  return point[0] < bounds.minLat - latitudePad ||
    point[0] > bounds.maxLat + latitudePad ||
    point[1] < bounds.minLon - longitudePad ||
    point[1] > bounds.maxLon + longitudePad;
}

function withinTolerance(point, entry, toleranceMeters) {
  return !beyondBounds(point, entry.bounds, toleranceMeters) &&
    distanceToPathMeters(point, entry.route.map.path) <= toleranceMeters;
}

// Group the routes by normalized street name once instead of rescanning the
// whole inventory for every block. Insertion order is preserved inside each
// bucket so the report keeps listing matched route ids in inventory order.
function indexRoutesByStreet(routeList) {
  const index = new Map();
  for (const route of routeList) {
    if (!Array.isArray(route.map?.path)) continue;
    const key = normalizeStreetName(route.streetName);
    let bucket = index.get(key);
    if (!bucket) index.set(key, bucket = []);
    bucket.push({ route, bounds: pathBounds(route.map.path) });
  }
  return index;
}

function samplePath(path, spacingMeters = 8) {
  const samples = [path[0]];
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    const steps = Math.max(1, Math.ceil(distanceMeters(start, end) / spacingMeters));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      samples.push([
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio
      ]);
    }
  }
  return samples;
}

function routeHasUsableSchedule(route) {
  return !route.dataUnavailable && Boolean(
    route.leftSweepingRule || route.rightSweepingRule || (Array.isArray(route.schedules) && route.schedules.length)
  );
}

function makeUnavailableRoute(block) {
  const path = block.geometry;
  return {
    id: `unavailable-${block.id}`,
    streetName: block.streetName,
    from: block.from,
    to: block.to,
    sweepType: "Unavailable",
    leftSweepDirection: "Left",
    rightSweepDirection: "Right",
    leftSweepingRule: "Denver route data unavailable — check posted signs.",
    rightSweepingRule: "Denver route data unavailable — check posted signs.",
    schedules: [],
    isPosted: false,
    dataUnavailable: true,
    expectedBlockId: block.id,
    map: { staticMapUrl: "", center: path[Math.floor(path.length / 2)], path },
    sourceNote: "Generated by the inventory auditor because a public roadway exists here but Denver returned no usable schedule."
  };
}

function auditInventory({ routes, blocks, matchToleranceMeters = 12, minimumCoverage = 0.9, generateUnavailable = true }) {
  const routeList = Array.from(routes.values ? routes.values() : routes);
  const routesByStreet = indexRoutesByStreet(routeList);
  const generatedRoutes = [];
  const blockResults = [];

  for (const block of blocks) {
    if (block.excluded) {
      blockResults.push({ id: block.id, streetName: block.streetName, status: "excluded", reason: block.exclusionReason || "excluded by area manifest" });
      continue;
    }
    if (!block.id || !block.streetName || !Array.isArray(block.geometry) || block.geometry.length < 2) {
      blockResults.push({ id: block.id || null, streetName: block.streetName || null, status: "unexplained-gap", reason: "invalid expected-block definition" });
      continue;
    }

    const streetKey = normalizeStreetName(block.streetName);
    let candidates = routesByStreet.get(streetKey);
    if (!candidates) routesByStreet.set(streetKey, candidates = []);
    const scheduled = candidates.filter((entry) => routeHasUsableSchedule(entry.route));
    const samples = samplePath(block.geometry);
    const coveredSamples = samples.filter((point) => scheduled.some((entry) => withinTolerance(point, entry, matchToleranceMeters)));
    const coverage = coveredSamples.length / samples.length;

    if (coverage >= minimumCoverage) {
      blockResults.push({ id: block.id, streetName: block.streetName, from: block.from, to: block.to, status: "scheduled", coverage, routeIds: scheduled.map((entry) => entry.route.id) });
      continue;
    }

    const existingUnavailable = candidates.find((entry) => entry.route.dataUnavailable && (
      entry.route.expectedBlockId === block.id || samples.every((point) => withinTolerance(point, entry, matchToleranceMeters))
    ));
    if (existingUnavailable) {
      blockResults.push({ id: block.id, streetName: block.streetName, from: block.from, to: block.to, status: "unavailable", coverage, routeIds: [existingUnavailable.route.id] });
    } else if (generateUnavailable) {
      const unavailable = makeUnavailableRoute(block);
      generatedRoutes.push(unavailable);
      candidates.push({ route: unavailable, bounds: pathBounds(unavailable.map.path) });
      blockResults.push({ id: block.id, streetName: block.streetName, from: block.from, to: block.to, status: "unavailable", coverage, routeIds: [unavailable.id], generated: true });
    } else {
      blockResults.push({ id: block.id, streetName: block.streetName, from: block.from, to: block.to, status: "unexplained-gap", coverage });
    }
  }

  const counts = blockResults.reduce((result, block) => {
    result[block.status] = (result[block.status] || 0) + 1;
    return result;
  }, { expected: blockResults.filter((block) => block.status !== "excluded").length, scheduled: 0, unavailable: 0, excluded: 0, "unexplained-gap": 0 });

  return {
    generatedRoutes,
    report: { version: 1, counts, blocks: blockResults },
    unexplainedGaps: blockResults.filter((block) => block.status === "unexplained-gap")
  };
}

module.exports = { auditInventory, makeUnavailableRoute, normalizeStreetName, routeHasUsableSchedule };
