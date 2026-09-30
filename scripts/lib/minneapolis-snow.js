// Turns Minneapolis's published snow emergency data into the curb lines the map draws. Pure: no
// network and no files, so every rule here can be tested against small made-up inputs. The fetching,
// caching and writing live in scripts/build-minneapolis-snow.js.
//
// The city publishes the rules as polygons, not lines. Each one is half of one block of one street:
// it runs from the street's centreline out about 14 m to one side, and carries DAY1, DAY2 and DAY3,
// where 1 means you may park there that day and 0 means you may not. It carries no street name. So
// each strip is matched to the centreline it lies along (PW_Street_Centerline, which has the name and
// the city's own snow emergency route flag), and the curb is drawn as that stretch of centreline
// pushed 4 m toward the strip's side, which is where Denver's curbs sit too.
//
// The two city datasets disagree on about 2% of curbs, and the disagreement fails in the dangerous
// direction: checked against the 10,806 tickets written in the 2025-26 season, even- and odd-side
// tickets were issued on streets the polygons call snow emergency routes (fine to park on days 2 and
// 3) and the centreline says are not routes. The tickets side with the centreline. So wherever the
// two disagree, or the address numbers on a side contradict the polygon's even/odd reading, the
// stricter reading is published and the curb says why. See HISTORY.md, Minneapolis snow emergencies.

const crypto = require("node:crypto");

const ORIGIN_LATITUDE = 44.98;
const METRES_PER_DEGREE = 111320;
const METRES_PER_DEGREE_LON = METRES_PER_DEGREE * Math.cos((ORIGIN_LATITUDE * Math.PI) / 180);

// How far the curb line sits from the centreline. Denver's offsetPoint in public/app.js moves a curb
// 0.000035 deg of latitude, about 3.9 m; this matches it so both cities look the same on the map.
const CURB_OFFSET_METRES = 4;
// A strip reaches about 14 m from its centreline, so a sample further than this is not on it.
const MATCH_DISTANCE_METRES = 25;
// A strip's end cap spills onto the cross street for at most about 14 m (half its right of way), so
// a stretch shorter than this on another centreline is spill, not a curb.
const MIN_PIECE_METRES = 20;
// Trim each curb back from the intersection so the two curbs of a corner do not meet in the middle.
const END_TRIM_METRES = 5;
const SAMPLE_SPACING_METRES = 5;
// Addresses sit on their parcels, usually 15 to 40 m from the centreline.
const ADDRESS_DISTANCE_METRES = 60;
const COORDINATE_DECIMALS = 6;
// A refreshed curb keeps its old id when a curb on the same street and side sits this close.
const ID_CONTINUITY_METRES = 15;

function toXY([lon, lat]) {
  return [lon * METRES_PER_DEGREE_LON, lat * METRES_PER_DEGREE];
}

function toLatLon([x, y]) {
  const round = (value) => Number(value.toFixed(COORDINATE_DECIMALS));
  return [round(y / METRES_PER_DEGREE), round(x / METRES_PER_DEGREE_LON)];
}

function pathLength(path) {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += Math.hypot(path[index][0] - path[index - 1][0], path[index][1] - path[index - 1][1]);
  }
  return total;
}

// Nearest point on a path: distance, arc length along the path, and which side it is on (positive
// is to the left walking the path's direction).
function projectOntoPath(point, path) {
  let best = null;
  let travelled = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const [ax, ay] = path[index];
    const [bx, by] = path[index + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const length = Math.sqrt(lengthSquared);
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared));
    const footX = ax + t * dx;
    const footY = ay + t * dy;
    const distance = Math.hypot(point[0] - footX, point[1] - footY);
    if (!best || distance < best.distance) {
      const cross = dx * (point[1] - ay) - dy * (point[0] - ax);
      best = { distance, along: travelled + t * length, side: Math.sign(cross) };
    }
    travelled += length;
  }
  return best;
}

function slicePath(path, start, end) {
  const out = [];
  let travelled = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const segmentStart = travelled;
    const segmentEnd = travelled + length;
    const at = (distance) => {
      const t = length === 0 ? 0 : (distance - segmentStart) / length;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    };
    if (segmentEnd >= start && segmentStart <= end) {
      if (!out.length) {
        out.push(at(Math.max(start, segmentStart)));
      }
      out.push(at(Math.min(end, segmentEnd)));
    }
    travelled = segmentEnd;
  }
  return out.filter((point, index) => index === 0 || Math.hypot(point[0] - out[index - 1][0], point[1] - out[index - 1][1]) > 0.01);
}

// Pushes a path sideways by `distance` (positive to the left of its direction), averaging the
// normals of the two segments at each interior vertex so a bend does not tear the line.
function offsetPath(path, distance) {
  const normals = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const dx = path[index + 1][0] - path[index][0];
    const dy = path[index + 1][1] - path[index][1];
    const length = Math.hypot(dx, dy) || 1;
    normals.push([-dy / length, dx / length]);
  }
  return path.map((point, index) => {
    const before = normals[Math.max(0, index - 1)];
    const after = normals[Math.min(normals.length - 1, index)];
    let nx = before[0] + after[0];
    let ny = before[1] + after[1];
    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;
    // Stretch the averaged normal so the offset stays `distance` from both segments at a bend.
    const cosine = Math.max(0.5, nx * after[0] + ny * after[1]);
    return [point[0] + (nx * distance) / cosine, point[1] + (ny * distance) / cosine];
  });
}

function densifyRing(ring) {
  const samples = [];
  for (let index = 0; index < ring.length - 1; index += 1) {
    const a = ring[index];
    const b = ring[index + 1];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(length / SAMPLE_SPACING_METRES));
    for (let step = 0; step < steps; step += 1) {
      samples.push([a[0] + ((b[0] - a[0]) * step) / steps, a[1] + ((b[1] - a[1]) * step) / steps]);
    }
  }
  return samples;
}

const STREET_SUFFIX_ALIASES = { TERR: "TER", PLACE: "PL", AVENUE: "AVE", STREET: "ST", DRIVE: "DR", PLZA: "PLZ", PLAZA: "PLZ" };

function normalizeStreetKey(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => STREET_SUFFIX_ALIASES[word] || word)
    .join(" ");
}

function buildAddressStreetName(attributes) {
  return normalizeStreetKey([attributes.StreetName, attributes.StreetType, attributes.PostDir].filter(Boolean).join(" "));
}

// A spatial index over centreline segments, in cells of `size` metres.
function buildCentrelineIndex(centrelines, size = 100) {
  const cells = new Map();
  centrelines.forEach((line, lineIndex) => {
    line.paths.forEach((path, pathIndex) => {
      for (let index = 0; index < path.length - 1; index += 1) {
        const [ax, ay] = path[index];
        const [bx, by] = path[index + 1];
        for (let cx = Math.floor(Math.min(ax, bx) / size); cx <= Math.floor(Math.max(ax, bx) / size); cx += 1) {
          for (let cy = Math.floor(Math.min(ay, by) / size); cy <= Math.floor(Math.max(ay, by) / size); cy += 1) {
            const key = `${cx},${cy}`;
            if (!cells.has(key)) cells.set(key, new Set());
            cells.get(key).add(`${lineIndex}:${pathIndex}`);
          }
        }
      }
    });
  });
  return {
    near(point, radius) {
      const found = new Set();
      for (let cx = Math.floor((point[0] - radius) / size); cx <= Math.floor((point[0] + radius) / size); cx += 1) {
        for (let cy = Math.floor((point[1] - radius) / size); cy <= Math.floor((point[1] + radius) / size); cy += 1) {
          (cells.get(`${cx},${cy}`) || []).forEach((key) => found.add(key));
        }
      }
      return found;
    }
  };
}

// Splits one strip into the stretches of centreline it covers. Each sample of the strip's outline
// goes to its nearest centreline; a centreline that collects a real length of samples is a curb.
function matchStripToCentrelines(stripRings, centrelines, index) {
  const samples = stripRings.flatMap(densifyRing);
  const byPath = new Map();
  samples.forEach((sample) => {
    let best = null;
    index.near(sample, MATCH_DISTANCE_METRES).forEach((key) => {
      const [lineIndex, pathIndex] = key.split(":").map(Number);
      const projection = projectOntoPath(sample, centrelines[lineIndex].paths[pathIndex]);
      if (projection.distance <= MATCH_DISTANCE_METRES && (!best || projection.distance < best.projection.distance)) {
        best = { key, projection };
      }
    });
    if (best) {
      if (!byPath.has(best.key)) byPath.set(best.key, []);
      byPath.get(best.key).push(best.projection);
    }
  });

  const stretches = [...byPath.entries()].map(([key, projections]) => {
    const [lineIndex, pathIndex] = key.split(":").map(Number);
    const along = projections.map((projection) => projection.along);
    // The side is the average signed offset of samples clearly off the centreline; the strip's inner
    // edge sits on the line itself and would only add noise.
    const offCentre = projections.filter((projection) => projection.distance > 1);
    const sideVote = offCentre.reduce((sum, projection) => sum + projection.side * projection.distance, 0);
    return {
      lineIndex,
      pathIndex,
      start: Math.min(...along),
      end: Math.max(...along),
      side: sideVote >= 0 ? 1 : -1,
      sampleCount: projections.length
    };
  });
  const real = stretches.filter((stretch) => stretch.end - stretch.start >= MIN_PIECE_METRES);
  if (real.length) {
    return real;
  }
  // A strip on a very short block never reaches the threshold; keep its best stretch rather than
  // dropping a curb the city does publish.
  const best = stretches.sort((a, b) => b.sampleCount - a.sampleCount)[0];
  return best ? [best] : [];
}

function classifyStripDays(days) {
  const [day1, day2, day3] = days;
  if (day1 === 0) return "route";
  if (day2 === 0 && day3 === 1) return "even";
  if (day3 === 0 && day2 === 1) return "odd";
  return "other";
}

// Majority parity of the house numbers on this side of this stretch of this street.
function findSideParity(streetKey, path, start, end, side, addressesByStreet) {
  const votes = { even: 0, odd: 0 };
  (addressesByStreet.get(streetKey) || []).forEach((address) => {
    const projection = projectOntoPath(address.xy, path);
    if (
      projection.distance <= ADDRESS_DISTANCE_METRES &&
      projection.along >= start - 5 &&
      projection.along <= end + 5 &&
      projection.side === side
    ) {
      votes[address.number % 2 === 0 ? "even" : "odd"] += 1;
    }
  });
  const total = votes.even + votes.odd;
  if (!total) return { parity: null, votes };
  if (votes.even >= total * 0.8) return { parity: "even", votes };
  if (votes.odd >= total * 0.8) return { parity: "odd", votes };
  return { parity: null, votes };
}

// Where the city's sources disagree, the curb gets the stricter rule and a note of why. A driver
// told to move who could have stayed loses a few minutes; one told to stay who should have moved
// gets ticketed and towed.
function resolvePublishedDays({ days, centrelineRoute, parity }) {
  const published = [...days];
  const conflicts = [];
  const stripClass = classifyStripDays(days);

  if (stripClass === "route" && centrelineRoute === "N") {
    conflicts.push("route-not-in-centreline");
    if (parity === "even") published[1] = 0;
    else if (parity === "odd") published[2] = 0;
    else {
      published[1] = 0;
      published[2] = 0;
    }
  }
  if (stripClass !== "route" && centrelineRoute === "Y") {
    conflicts.push("centreline-says-route");
    published[0] = 0;
  }
  if ((stripClass === "even" && parity === "odd") || (stripClass === "odd" && parity === "even")) {
    conflicts.push("parity-mismatch");
    published[1] = 0;
    published[2] = 0;
  }
  return { published, conflicts, stripClass };
}

// The compass side of a curb, in the same vocabulary Denver's curbs use (north/south or east/west).
function getCompassSide(path, side) {
  const [first, last] = [path[0], path[path.length - 1]];
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  // The left normal of the path's overall direction, flipped to the strip's side.
  const nx = -dy * side;
  const ny = dx * side;
  return Math.abs(dx) >= Math.abs(dy) ? (ny > 0 ? "north" : "south") : nx > 0 ? "east" : "west";
}

function buildCurbKey(street, sideKey, midpoint) {
  const text = `${street}|${sideKey}|${midpoint[0].toFixed(4)},${midpoint[1].toFixed(4)}`;
  return `mpls:${crypto.createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

function getMidpoint(geometry) {
  return geometry[Math.floor(geometry.length / 2)];
}

// Keeps a curb's id across a season's refresh, so saved curbs and the phones watching them survive
// the city renumbering or nudging its polygons. A new curb inherits the id of a previous curb on the
// same street and side within ID_CONTINUITY_METRES; anything else gets a fresh id.
function carryForwardIds(curbs, previousCurbs) {
  const previousByStreetSide = new Map();
  (previousCurbs || []).forEach((curb) => {
    const key = `${curb.street}|${curb.sideKey}`;
    if (!previousByStreetSide.has(key)) previousByStreetSide.set(key, []);
    previousByStreetSide.get(key).push(curb);
  });
  const claimed = new Set();
  const used = new Set();
  let carried = 0;
  const out = curbs.map((curb) => {
    const mid = toXY([getMidpoint(curb.geometry)[1], getMidpoint(curb.geometry)[0]]);
    let best = null;
    (previousByStreetSide.get(`${curb.street}|${curb.sideKey}`) || []).forEach((previous) => {
      if (claimed.has(previous.id)) return;
      const previousMid = toXY([getMidpoint(previous.geometry)[1], getMidpoint(previous.geometry)[0]]);
      const distance = Math.hypot(mid[0] - previousMid[0], mid[1] - previousMid[1]);
      if (distance <= ID_CONTINUITY_METRES && (!best || distance < best.distance)) best = { previous, distance };
    });
    let id;
    if (best) {
      id = best.previous.id;
      claimed.add(id);
      carried += 1;
    } else {
      id = buildCurbKey(curb.street, curb.sideKey, getMidpoint(curb.geometry));
      let suffix = 2;
      while (used.has(id)) {
        id = `${buildCurbKey(curb.street, curb.sideKey, getMidpoint(curb.geometry))}-${suffix}`;
        suffix += 1;
      }
    }
    used.add(id);
    return { ...curb, id };
  });
  const retired = (previousCurbs || []).filter((curb) => !claimed.has(curb.id)).map((curb) => curb.id);
  return { curbs: out, carried, retired };
}

function prepareCentrelines(features) {
  return features
    .filter((feature) => feature.geometry && Array.isArray(feature.geometry.paths))
    .map((feature) => ({
      id: feature.attributes.OBJECTID,
      street: normalizeStreetKey(feature.attributes.STREET_O_NAME),
      route: feature.attributes.SNOW_EMERGENCY_ROUTE === "Y" ? "Y" : feature.attributes.SNOW_EMERGENCY_ROUTE === "N" ? "N" : null,
      paths: feature.geometry.paths.map((path) => path.map(toXY)).filter((path) => path.length >= 2)
    }))
    .filter((line) => line.street && line.paths.length);
}

function prepareAddresses(features) {
  const byStreet = new Map();
  features.forEach((feature) => {
    const number = Number(feature.attributes.AddrNum);
    if (!feature.geometry || !Number.isInteger(number) || number <= 0) return;
    const street = buildAddressStreetName(feature.attributes);
    if (!byStreet.has(street)) byStreet.set(street, []);
    byStreet.get(street).push({ number, xy: toXY([feature.geometry.x, feature.geometry.y]) });
  });
  return byStreet;
}

function readStripDays(attributes) {
  const read = (value) => (value === 0 || value === 1 ? value : null);
  return [read(attributes.DAY1), read(attributes.DAY2), read(attributes.DAY3)];
}

// The whole pipeline: strip features, centreline features and address features in, curbs and a
// report out. `previousCurbs` is the last published payload's curbs, for id continuity.
function buildSnowCurbs({ strips, centrelineFeatures, addressFeatures, previousCurbs = [] }) {
  const centrelines = prepareCentrelines(centrelineFeatures);
  const index = buildCentrelineIndex(centrelines);
  const addressesByStreet = prepareAddresses(addressFeatures);
  const report = {
    strips: strips.length,
    stripsWithoutGeometry: 0,
    stripsWithUnreadableDays: 0,
    stripsUnmatched: 0,
    curbs: 0,
    parity: { even: 0, odd: 0, unknown: 0 },
    conflicts: {},
    conflictStreets: {}
  };
  const curbs = [];

  strips.forEach((strip) => {
    const rings = strip.geometry?.rings;
    if (!Array.isArray(rings) || !rings.length) {
      report.stripsWithoutGeometry += 1;
      return;
    }
    const days = readStripDays(strip.attributes);
    if (days.includes(null)) {
      report.stripsWithUnreadableDays += 1;
      return;
    }
    const stretches = matchStripToCentrelines(rings.map((ring) => ring.map(toXY)), centrelines, index);
    if (!stretches.length) {
      report.stripsUnmatched += 1;
      return;
    }

    stretches.forEach((stretch) => {
      const line = centrelines[stretch.lineIndex];
      const path = line.paths[stretch.pathIndex];
      const available = stretch.end - stretch.start;
      const trim = Math.min(END_TRIM_METRES, available * 0.2);
      const centreSlice = slicePath(path, stretch.start + trim, stretch.end - trim);
      if (centreSlice.length < 2 || pathLength(centreSlice) < 1) return;
      const geometryXY = offsetPath(centreSlice, CURB_OFFSET_METRES * stretch.side);
      const { parity, votes } = findSideParity(line.street, path, stretch.start, stretch.end, stretch.side, addressesByStreet);
      const { published, conflicts, stripClass } = resolvePublishedDays({ days, centrelineRoute: line.route, parity });

      report.parity[parity || "unknown"] += 1;
      conflicts.forEach((conflict) => {
        report.conflicts[conflict] = (report.conflicts[conflict] || 0) + 1;
        const streets = (report.conflictStreets[conflict] = report.conflictStreets[conflict] || {});
        streets[line.street] = (streets[line.street] || 0) + 1;
      });

      curbs.push({
        street: line.street,
        sideKey: getCompassSide(centreSlice, stretch.side),
        parity,
        stripClass,
        // Published rule, 1 = may park that day. `cityDays` is the polygon's own reading, kept so a
        // curb that was made stricter can say what changed.
        days: published,
        cityDays: days,
        conflicts,
        addressVotes: votes,
        geometry: geometryXY.map(toLatLon)
      });
    });
  });

  const continuity = carryForwardIds(curbs, previousCurbs);
  report.curbs = continuity.curbs.length;
  report.idsCarriedForward = continuity.carried;
  report.idsRetired = continuity.retired.length;
  report.retiredIds = continuity.retired;
  return { curbs: continuity.curbs, report };
}

// Distance in metres from a [lat, lon] point to a curb's [lat, lon] geometry.
function distanceToCurb(point, geometry) {
  return projectOntoPath(toXY([point[1], point[0]]), geometry.map(([lat, lon]) => toXY([lon, lat]))).distance;
}

// Checks published curbs against tickets the city actually wrote. A ticket for day N is explained
// when a curb within `tolerance` metres bans parking that day; one whose nearby curbs all say you may
// park is the failure that matters, because the app would have told that driver to stay.
function checkAgainstTickets(curbs, tickets, tolerance = 20) {
  const cellSize = 100;
  const cells = new Map();
  curbs.forEach((curb, curbIndex) => {
    curb.geometry.forEach(([lat, lon]) => {
      const [x, y] = toXY([lon, lat]);
      const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
      if (!cells.has(key)) cells.set(key, new Set());
      cells.get(key).add(curbIndex);
    });
  });
  // The city places a ticket it could not geocode precisely at one stand-in point per street: on
  // Emerson Ave S, 3105, 3425 and 3537 all sit at the same spot by Lake St, which happens to be a snow
  // emergency route. A point shared by several different addresses says nothing about which curb the
  // car was on, so it is counted apart rather than scored.
  const addressesAtPoint = new Map();
  tickets.forEach((ticket) => {
    const key = `${ticket.Latitude},${ticket.Longitude}`;
    if (!addressesAtPoint.has(key)) addressesAtPoint.set(key, new Set());
    addressesAtPoint.get(key).add(ticket.Address);
  });
  const result = { byDay: {}, sharedLocation: 0, missingCoordinates: 0 };
  tickets.forEach((ticket) => {
    const day = Number(ticket.Day);
    if (![1, 2, 3].includes(day)) return;
    const bucket = (result.byDay[day] = result.byDay[day] || { tickets: 0, explained: 0, contradicted: 0, noCurb: 0 });
    if (!Number(ticket.Latitude) || !Number(ticket.Longitude)) {
      result.missingCoordinates += 1;
      return;
    }
    if (addressesAtPoint.get(`${ticket.Latitude},${ticket.Longitude}`).size >= 3) {
      result.sharedLocation += 1;
      return;
    }
    bucket.tickets += 1;
    const point = [Number(ticket.Latitude), Number(ticket.Longitude)];
    const [x, y] = toXY([point[1], point[0]]);
    const nearby = new Set();
    for (let cx = Math.floor((x - 150) / cellSize); cx <= Math.floor((x + 150) / cellSize); cx += 1) {
      for (let cy = Math.floor((y - 150) / cellSize); cy <= Math.floor((y + 150) / cellSize); cy += 1) {
        (cells.get(`${cx},${cy}`) || []).forEach((curbIndex) => nearby.add(curbIndex));
      }
    }
    const close = [...nearby].filter((curbIndex) => distanceToCurb(point, curbs[curbIndex].geometry) <= tolerance);
    if (!close.length) bucket.noCurb += 1;
    else if (close.some((curbIndex) => curbs[curbIndex].days[day - 1] === 0)) bucket.explained += 1;
    else bucket.contradicted += 1;
  });
  return result;
}

module.exports = {
  CURB_OFFSET_METRES,
  normalizeStreetKey,
  buildAddressStreetName,
  classifyStripDays,
  resolvePublishedDays,
  getCompassSide,
  offsetPath,
  slicePath,
  projectOntoPath,
  carryForwardIds,
  buildSnowCurbs,
  checkAgainstTickets,
  toXY
};
