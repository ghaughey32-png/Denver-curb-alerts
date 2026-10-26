// Turns Boston's published street sweeping schedule (Public Works, data.boston.gov dataset
// 9fdbdcad-67c8-4b23-b6ec-861e77d56227) and its street segments (Boston Street Segments, SAM system)
// into the curbs the app will draw. Pure: no network and no files, so every rule here can be tested
// against small made-up rows. The fetching, caching and writing live in scripts/build-boston-sweeping.js.
// See BOSTON-PLAN.md and HISTORY.md, "Boston research (2026-10-13)" and "Boston Phase 0 and 1".
//
// Unlike SF, the schedule has NO geometry and shares no key with the segments. A row says "Commonwealth
// Ave, odd side, Arlington St to Massachusetts Ave, 0.93 miles"; the work here is finding those blocks
// on the street layer. The method, and why it is trusted:
//
//   1. Index segments by street name (core words plus a normalised suffix, alternate names included).
//   2. Join segment endpoints into a graph (endpoints within NODE_SNAP_METRES are one node).
//   3. Find the nodes where the row's street meets its `from` and `to` cross streets, then take the
//      shortest path along the row's street between a from-node and a to-node, choosing the pair
//      whose path length is closest to the row's own `miles`.
//   4. Accept the row as CONFIDENT only if both ends resolved and the path is within
//      LENGTH_BAND_LOW..LENGTH_BAND_HIGH of `miles`. The row's own length is the only validation the
//      data gives us, so it is the gate. A row that resolves one end, or whose length is off, is
//      reported and NOT published: never publish a guess as a rule.
//   5. Put the row on the side of each path segment whose house numbers have the row's parity.
//
// SHAPE OF A CURB (what public/boston-sweeping.json holds):
//
//   { id, street, sideKey, median?, opposite?, addresses?, schedules, geometry }
//
// A curb is one block side (segment + left/right), the union of EVERY row that covers it. The city's
// own lookup shows a single pick and has hidden a real tow rule on Commonwealth Ave, so the app shows
// all of them. `schedules` holds one entry per distinct row window:
//
//   { days, weeks, start, end, season, nightBefore, standing, mainId }
//
//   days        weekday numbers, 0 = Sunday ... 6 = Saturday
//   weeks       which weeks of the month the row lists (1-5). The city lists the 5th week where it
//               applies, so it is used as given and never inferred
//   start/end   the POSTED window as "HH:MM" strings. Posted hours are the sign's, not our promise.
//               A window that ends before it starts is a typo in the city's data; it is kept as given
//               and counted in the report
//   season      "apr-nov", "mar-dec" (North End, South End, Beacon Hill) or "year-round"
//   nightBefore the window starts before 5 am, so the car moves the evening before (as in SF)
//   standing    an every-day, year-round row: a nightly restriction, not a sweep. Shown on the curb
//               sheet; never a reminder for every night
//   mainId      the city's row id, for tracing a curb back to its source
//
// A "Median" row (the city never says what that means) is its own curb with `median: true`, drawn on
// the centreline, never merged into the outer curb. Rows whose side is one of the city's other labels
// (Inbound, Ramp, Bridge, ...) are reported, not published.
//
// Geometry is [lat, lng] pairs, seven decimals. The city draws a segment once, so each side is pushed
// CURB_OFFSET_METRES toward its own side, as SF's is, or a tap could not tell the two sides apart.

const crypto = require("node:crypto");

const COORDINATE_DECIMALS = 7;
const CURB_OFFSET_METRES = 4;
const NODE_SNAP_METRES = 3;
const LENGTH_BAND_LOW = 0.8;
const LENGTH_BAND_HIGH = 1.25;
const METRES_PER_MILE = 1609.344;
const NIGHT_BEFORE_START_HOUR = 5;
const ORIGIN_LATITUDE = 42.36;
const METRES_PER_DEGREE = 111320;
const METRES_PER_DEGREE_LON = METRES_PER_DEGREE * Math.cos((ORIGIN_LATITUDE * Math.PI) / 180);

// Daytime sweeping runs April 1 to November 30 everywhere except these districts, which start in March
// and end in December. Night sweeping and any row marked year-round ignore the season.
const EARLY_SEASON_DISTRICTS = new Set(["north end", "south end", "beacon hill"]);

const SUFFIXES = {
  st: "st", street: "st", ave: "ave", av: "ave", avenue: "ave", rd: "rd", road: "rd", dr: "dr", drive: "dr",
  ln: "ln", lane: "ln", pl: "pl", place: "pl", ct: "ct", court: "ct", blvd: "blvd", boulevard: "blvd",
  way: "way", sq: "sq", square: "sq", ter: "ter", terrace: "ter", pkwy: "pkwy", parkway: "pkwy",
  hwy: "hwy", highway: "hwy", cir: "cir", circle: "cir", wharf: "wharf", whf: "wharf", pk: "pk", park: "park",
  path: "path", walk: "walk", row: "row", alley: "aly", aly: "aly", plz: "plz", plaza: "plz", bridge: "brg",
  brg: "brg", tpke: "tpke", turnpike: "tpke", xing: "xing", crossing: "xing", ext: "ext", extension: "ext",
  hl: "hl", hill: "hl", pt: "pt", point: "pt", ctr: "ctr", center: "ctr", sq: "sq", cswy: "cswy", causeway: "cswy"
};
const DIRECTIONS = { n: "n", north: "n", s: "s", south: "s", e: "e", east: "e", w: "w", west: "w" };
const NUMBER_WORDS = {
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th", sixth: "6th", seventh: "7th",
  eighth: "8th", ninth: "9th", tenth: "10th", eleventh: "11th", twelfth: "12th", thirteenth: "13th"
};
// The schedule abbreviates where the street layer spells out ("Mt Pleasant Ave" is "Mount Pleasant").
const TOKEN_ALIASES = { mt: "mount", ft: "fort" };
// Generational suffixes the two files use inconsistently ("Martin Luther King Jr Blvd").
const DROPPED_TOKENS = new Set(["jr", "sr"]);
const CROSS_STREET_NOISE = /^(dead end|town line|city line|end|\s*)$/i;

// ---- CSV ---------------------------------------------------------------------------------------

// Reads CSV with quoted fields and either line ending. The city's export ends lines with CRLF, which
// turns the last column's header into "hista\r" under a naive split.
function parseCsv(text) {
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header, ...body] = records;
  return body.map((values) => Object.fromEntries(header.map((name, column) => [name.trim(), values[column] ?? ""])));
}

// ---- Names -------------------------------------------------------------------------------------

function tokenize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9/ -]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] || TOKEN_ALIASES[token] || token)
    .filter((token) => !DROPPED_TOKENS.has(token))
    .join(" ")
    .replace(/\bla grange\b/, "lagrange")
    .split(" ");
}

// Splits a street name into the words that identify it and its type: "Brighton Av" and "BRIGHTON AVE"
// are { core: "brighton", suffix: "ave" }. A leading direction stays in the core ("n washington").
// A name with no recognisable type keeps suffix "".
function normalizeStreetName(name) {
  const tokens = tokenize(name);
  if (tokens[0] === "saint") tokens[0] = "st";
  let suffix = "";
  if (tokens.length > 1 && SUFFIXES[tokens[tokens.length - 1]]) suffix = SUFFIXES[tokens.pop()];
  if (tokens.length > 1 && DIRECTIONS[tokens[tokens.length - 1]] && !suffix) {
    // "Washington St N" style trailing direction: drop it from the key, the suffix check still holds.
    tokens.pop();
  } else if (tokens.length > 1 && DIRECTIONS[tokens[tokens.length - 1]] && suffix) {
    tokens.pop();
  }
  if (tokens.length > 1 && DIRECTIONS[tokens[0]]) tokens[0] = DIRECTIONS[tokens[0]];
  return { core: tokens.join(" "), suffix };
}

function formatStreetName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b([a-z])([a-z]*)/g, (match, first, rest) => first.toUpperCase() + rest)
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (match, number, ordinal) => number + ordinal.toLowerCase());
}

// ---- Geometry ----------------------------------------------------------------------------------

function toXY([lat, lon]) {
  return [lon * METRES_PER_DEGREE_LON, lat * METRES_PER_DEGREE];
}

function fromXY([x, y]) {
  return [y / METRES_PER_DEGREE, x / METRES_PER_DEGREE_LON];
}

function readLine(geometry) {
  const coordinates = geometry?.type === "LineString" ? geometry.coordinates : null;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const path = coordinates.map(([lon, lat]) => [Number(lat), Number(lon)]);
  return path.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon)) ? path : null;
}

function pathLength(path) {
  const points = path.map(toXY);
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  }
  return total;
}

function roundPath(path) {
  return path.map(([lat, lon]) => [Number(lat.toFixed(COORDINATE_DECIMALS)), Number(lon.toFixed(COORDINATE_DECIMALS))]);
}

function getTravelDirection(path) {
  const points = path.map(toXY);
  let dx = points[points.length - 1][0] - points[0][0];
  let dy = points[points.length - 1][1] - points[0][1];
  if (Math.hypot(dx, dy) < 1) {
    let longest = 0;
    for (let index = 1; index < points.length; index += 1) {
      const length = Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
      if (length > longest) {
        longest = length;
        dx = points[index][0] - points[index - 1][0];
        dy = points[index][1] - points[index - 1][1];
      }
    }
  }
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

// Which way a curb faces. `side` is 1 for the left of the line's direction of travel and -1 for the
// right (the SAM layer's left/right address ranges follow the digitised direction).
function getSideKey(path, side) {
  const [dx, dy] = getTravelDirection(path);
  const nx = -dy * side;
  const ny = dx * side;
  return Math.abs(nx) >= Math.abs(ny) ? (nx > 0 ? "east" : "west") : ny > 0 ? "north" : "south";
}

function offsetPath(path, distance) {
  const points = path.map(toXY);
  const normals = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const dx = points[index + 1][0] - points[index][0];
    const dy = points[index + 1][1] - points[index][1];
    const length = Math.hypot(dx, dy) || 1;
    normals.push([-dy / length, dx / length]);
  }
  return points.map((point, index) => {
    const before = normals[Math.max(0, index - 1)];
    const after = normals[Math.min(normals.length - 1, index)];
    let nx = before[0] + after[0];
    let ny = before[1] + after[1];
    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;
    const cosine = Math.max(0.5, nx * after[0] + ny * after[1]);
    return fromXY([point[0] + (nx * distance) / cosine, point[1] + (ny * distance) / cosine]);
  });
}

// ---- Rows --------------------------------------------------------------------------------------

const WEEKDAY_COLUMNS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const isTrue = (value) => String(value).trim().toLowerCase() === "t";

function readHour(text) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(text || "").trim());
  return match ? Number(match[1]) + Number(match[2]) / 60 : null;
}

function normalizeTime(text) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(text || "").trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

function getSeason(row) {
  if (isTrue(row.year_round)) return "year-round";
  return EARLY_SEASON_DISTRICTS.has(String(row.dist_name || "").trim().toLowerCase()) ? "mar-dec" : "apr-nov";
}

// One row's rule. Returns null (with a reason) when the row cannot be read at all.
function readSchedule(row) {
  const days = WEEKDAY_COLUMNS.map((column, day) => (isTrue(row[column]) ? day : null)).filter((day) => day !== null);
  const weeks = [1, 2, 3, 4, 5].filter((week) => isTrue(row[`week_${week}`]));
  const start = normalizeTime(row.start_time);
  const end = normalizeTime(row.end_time);
  if (!days.length || !weeks.length || !start || !end) return { schedule: null, reason: "unreadable-rule" };
  const startHour = readHour(start);
  const endHour = readHour(end);
  const schedule = {
    days,
    weeks,
    start,
    end,
    season: getSeason(row),
    nightBefore: startHour < NIGHT_BEFORE_START_HOUR,
    standing: isTrue(row.every_day) && isTrue(row.year_round),
    mainId: Number(row.main_id)
  };
  return { schedule, endsBeforeStart: endHour <= startHour && !(startHour < NIGHT_BEFORE_START_HOUR && endHour > 0) };
}

function scheduleKey(schedule) {
  return [schedule.days.join(""), schedule.weeks.join(""), schedule.start, schedule.end, schedule.season, schedule.standing].join("|");
}

// Two rows with the same window on the same curb are one rule; keeping both mainIds lets the curb be
// traced back to either.
function mergeSchedules(schedules) {
  const byKey = new Map();
  schedules.forEach((schedule) => {
    const key = scheduleKey(schedule);
    const existing = byKey.get(key);
    if (existing) {
      existing.mainIds.push(schedule.mainId);
    } else {
      const { mainId, ...rest } = schedule;
      byKey.set(key, { ...rest, mainIds: [mainId] });
    }
  });
  return [...byKey.values()]
    .map(({ mainIds, ...rest }) => ({ ...rest, mainId: Math.min(...mainIds), ...(mainIds.length > 1 ? { mainIds: mainIds.sort((a, b) => a - b) } : {}) }))
    .sort((a, b) => a.mainId - b.mainId);
}

// ---- Segments and the graph --------------------------------------------------------------------

function readHouseNumber(value) {
  const number = Number.parseInt(String(value ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// The parity ("odd" or "even") of the house numbers on one side, or null when the side lists none.
function readSideParity(from, to) {
  const number = readHouseNumber(from) ?? readHouseNumber(to);
  return number === null ? null : number % 2 ? "odd" : "even";
}

function readSegments(features) {
  const segments = [];
  features.forEach((feature) => {
    const line = readLine(feature.geometry);
    const properties = feature.properties || {};
    if (!line || properties.SEGMENT_ID == null) return;
    const name = [properties.PRE_DIR, properties.ST_NAME, properties.ST_TYPE, properties.SUF_DIR].filter(Boolean).join(" ");
    const names = [normalizeStreetName(name)];
    if (properties.ALTERNATE_NAME) {
      String(properties.ALTERNATE_NAME)
        .split(/[;|]/)
        .forEach((alternate) => names.push(normalizeStreetName(alternate)));
    }
    const left = readSideParity(properties.L_F_ADD, properties.L_T_ADD);
    const right = readSideParity(properties.R_F_ADD, properties.R_T_ADD);
    segments.push({
      id: Number(properties.SEGMENT_ID),
      displayName: formatStreetName([properties.PRE_DIR, properties.ST_NAME, properties.ST_TYPE, properties.SUF_DIR].filter(Boolean).join(" ")),
      names,
      line,
      length: pathLength(line),
      parity: { left, right },
      addresses: {
        left: [readHouseNumber(properties.L_F_ADD), readHouseNumber(properties.L_T_ADD)],
        right: [readHouseNumber(properties.R_F_ADD), readHouseNumber(properties.R_T_ADD)]
      }
    });
  });
  return segments;
}

// Endpoints within NODE_SNAP_METRES are one node. A grid of that cell size finds neighbours without
// comparing every pair; clustering is by first-come union, which is enough at 3 m.
function buildNodes(segments) {
  const cell = NODE_SNAP_METRES;
  const grid = new Map();
  const nodes = [];
  const find = (point) => {
    const [x, y] = toXY(point);
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best = null;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        (grid.get(`${cx + dx}|${cy + dy}`) || []).forEach((index) => {
          const distance = Math.hypot(nodes[index].xy[0] - x, nodes[index].xy[1] - y);
          if (distance <= NODE_SNAP_METRES && (!best || distance < best.distance)) best = { index, distance };
        });
      }
    }
    if (best) return best.index;
    nodes.push({ xy: [x, y] });
    const key = `${cx}|${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(nodes.length - 1);
    return nodes.length - 1;
  };
  segments.forEach((segment) => {
    segment.from = find(segment.line[0]);
    segment.to = find(segment.line[segment.line.length - 1]);
  });
}

function indexSegments(segments) {
  const byCore = new Map();
  segments.forEach((segment) => {
    segment.names.forEach((name) => {
      if (!name.core) return;
      if (!byCore.has(name.core)) byCore.set(name.core, new Set());
      byCore.get(name.core).add(segment);
    });
  });
  return byCore;
}

// The segments a schedule name refers to. When the street layer has the core name with the same type
// the match is exact on type; otherwise every segment with that core name counts, so "Brighton Av"
// finds "BRIGHTON AVE" and a missing or odd type does not lose the street.
function findStreet(index, name) {
  const wanted = normalizeStreetName(name);
  if (!wanted.core) return [];
  let candidates = index.get(wanted.core);
  if (!candidates) {
    // A name that is the tail of exactly one longer street ("Joe L Smith" for "Bishop Joe L Smith"),
    // or the reverse. Taken only when one street fits, so it can never pick between two.
    const near = [...index.keys()].filter((core) => core.endsWith(` ${wanted.core}`) || wanted.core.endsWith(` ${core}`));
    if (near.length !== 1 || wanted.core.split(" ").length < 2 && near[0].split(" ").length < 3) return [];
    candidates = index.get(near[0]);
  }
  const all = [...candidates];
  if (!wanted.suffix) return all;
  const typed = all.filter((segment) => segment.names.some((candidate) => candidate.core === wanted.core && candidate.suffix === wanted.suffix));
  return typed.length ? typed : all;
}

// ---- The join ----------------------------------------------------------------------------------

function buildAdjacency(segments) {
  const adjacency = new Map();
  const add = (node, segment, other) => {
    if (!adjacency.has(node)) adjacency.set(node, []);
    adjacency.get(node).push({ segment, other });
  };
  segments.forEach((segment) => {
    add(segment.from, segment, segment.to);
    add(segment.to, segment, segment.from);
  });
  return adjacency;
}

// Dijkstra over one street's own segments. Returns distance and the segment that reached each node.
function shortestPaths(adjacency, start, maxDistance) {
  const distance = new Map([[start, 0]]);
  const via = new Map();
  const queue = [[0, start]];
  while (queue.length) {
    let best = 0;
    for (let index = 1; index < queue.length; index += 1) if (queue[index][0] < queue[best][0]) best = index;
    const [travelled, node] = queue.splice(best, 1)[0];
    if (travelled > distance.get(node)) continue;
    (adjacency.get(node) || []).forEach(({ segment, other }) => {
      const next = travelled + segment.length;
      if (next > maxDistance) return;
      if (!distance.has(other) || next < distance.get(other)) {
        distance.set(other, next);
        via.set(other, { segment, from: node });
        queue.push([next, other]);
      }
    });
  }
  return { distance, via };
}

function walkBack(via, end) {
  const segments = [];
  let node = end;
  while (via.has(node)) {
    const step = via.get(node);
    segments.push(step.segment);
    node = step.from;
  }
  return segments;
}

// The nodes where the row's street meets the named cross street, or null when the end is not a
// street we can place: a dead end, a town line, a name the street layer lacks, or the street itself.
function findMeetingNodes(index, streetSegments, streetName, crossName) {
  if (CROSS_STREET_NOISE.test(String(crossName || "").trim())) return { nodes: null, reason: "open-end" };
  if (normalizeStreetName(crossName).core === normalizeStreetName(streetName).core) return { nodes: null, reason: "self-reference" };
  const cross = findStreet(index, crossName);
  if (!cross.length) return { nodes: null, reason: "cross-street-not-found" };
  const streetNodes = new Set();
  streetSegments.forEach((segment) => {
    streetNodes.add(segment.from);
    streetNodes.add(segment.to);
  });
  const nodes = new Set();
  cross.forEach((segment) => {
    if (streetNodes.has(segment.from)) nodes.add(segment.from);
    if (streetNodes.has(segment.to)) nodes.add(segment.to);
  });
  return nodes.size ? { nodes: [...nodes], reason: null } : { nodes: null, reason: "cross-street-does-not-meet" };
}

// The nodes at the ends of the street's own segments: touched by one segment of the street and no more.
// A "Dead End", a town line, or a cross street that is the street itself ends here.
function findLeafNodes(streetSegments) {
  const degree = new Map();
  streetSegments.forEach((segment) => {
    degree.set(segment.from, (degree.get(segment.from) || 0) + 1);
    degree.set(segment.to, (degree.get(segment.to) || 0) + 1);
  });
  return [...degree].filter(([, count]) => count === 1).map(([node]) => node);
}

// Places one row on the street layer. `status` is "confident" (both ends placed, length in band),
// "partial" (one end placed, or the whole street used), or one of the failure reasons.
function matchRow(row, index, miles) {
  const target = miles * METRES_PER_MILE;
  const streetSegments = findStreet(index, row.st_name);
  if (!streetSegments.length) return { status: "street-not-found" };
  const adjacency = buildAdjacency(streetSegments);
  const from = findMeetingNodes(index, streetSegments, row.st_name, row.from);
  const to = findMeetingNodes(index, streetSegments, row.st_name, row.to);
  const reach = target * 1.6;
  // An end we cannot place as a street is tried as a leaf of the street (see findLeafNodes). The length
  // band still has to hold, so a leaf end is a constraint, not a free pass.
  const leaves = findLeafNodes(streetSegments);
  const leafEnds = [];
  if (!from.nodes && leaves.length) {
    from.nodes = leaves;
    leafEnds.push("from");
  }
  if (!to.nodes && leaves.length) {
    to.nodes = leaves;
    leafEnds.push("to");
  }

  if (from.nodes && to.nodes) {
    let best = null;
    from.nodes.forEach((start) => {
      const { distance, via } = shortestPaths(adjacency, start, reach);
      to.nodes.forEach((end) => {
        if (end === start || !distance.has(end)) return;
        const error = Math.abs(distance.get(end) - target) / target;
        if (!best || error < best.error) best = { error, length: distance.get(end), via, end };
      });
    });
    if (!best) return { status: "no-path", from: from.reason, to: to.reason };
    const segments = walkBack(best.via, best.end);
    const ratio = best.length / target;
    const status = ratio >= LENGTH_BAND_LOW && ratio <= LENGTH_BAND_HIGH ? "confident" : "out-of-band";
    return { status, ratio, segments, leafEnds };
  }

  const placed = from.nodes || to.nodes;
  if (placed) {
    let best = null;
    placed.forEach((start) => {
      const { distance, via } = shortestPaths(adjacency, start, reach);
      distance.forEach((travelled, node) => {
        if (node === start) return;
        const error = Math.abs(travelled - target) / target;
        if (!best || error < best.error) best = { error, length: travelled, via, end: node };
      });
    });
    if (!best) return { status: "no-path", from: from.reason, to: to.reason };
    return { status: "partial", ratio: best.length / target, segments: walkBack(best.via, best.end), reason: "one-end" };
  }

  const total = streetSegments.reduce((sum, segment) => sum + segment.length, 0);
  const ratio = total / target;
  if (ratio >= LENGTH_BAND_LOW && ratio <= LENGTH_BAND_HIGH) return { status: "partial", ratio, segments: streetSegments, reason: "whole-street" };
  return { status: "no-ends", from: from.reason, to: to.reason, ratio };
}

// ---- Sides -------------------------------------------------------------------------------------

function readSideLabel(side) {
  const label = String(side || "").trim().toLowerCase();
  if (label === "odd") return { parity: "odd" };
  if (label === "even") return { parity: "even" };
  if (label === "") return { both: true };
  if (label === "both") return { both: true };
  if (label === "odd side median") return { parity: "odd", median: true };
  if (label === "even side median") return { parity: "even", median: true };
  if (label === "median") return { both: true, median: true };
  return { unsupported: true };
}

// The side of a segment (1 left, -1 right) that carries a parity. Where the layer lists numbers on
// both sides with different parity this is exact; where it lists one side the other is the opposite
// parity; with none the conventional odd-right, even-left is used and the guess is counted.
function pickSide(segment, parity) {
  const { left, right } = segment.parity;
  if (left === parity && right !== parity) return { side: 1, guessed: false };
  if (right === parity && left !== parity) return { side: -1, guessed: false };
  if (left && right && left !== right) return { side: left === parity ? 1 : -1, guessed: false };
  if (left && !right) return { side: left === parity ? 1 : -1, guessed: true };
  if (right && !left) return { side: right === parity ? -1 : 1, guessed: true };
  return { side: parity === "odd" ? -1 : 1, guessed: true };
}

function buildCurbId(segmentId, side, median) {
  return `bos:${crypto.createHash("sha1").update(`${segmentId}|${side}${median ? "|m" : ""}`).digest("hex").slice(0, 10)}`;
}

// ---- The station check -------------------------------------------------------------------------

// `losta` and `hista` are not house numbers: on every row hista - losta is exactly miles x 5280, so they
// are feet along the street from its start (HISTORY.md, "Boston hold-out check"). The join never reads
// them, which makes them an independent test of where it put a row: a block placed correctly sits
// `losta` feet from the street's start and its far end `hista` feet. The street's start is not known, so
// each street (rows sharing the city's `parent` code) takes the one origin, among its matched rows'
// ends, that best explains its rows; that one fitted choice per street is the only freedom the test has.
const STATION_TOLERANCE_FRACTION = 0.1;
const STATION_TOLERANCE_MIN_METRES = 60;
const FEET_TO_METRES = 0.3048;

// The two nodes where a path starts and ends: the nodes touched by an odd number of its segments. A
// closed loop or a path that doubles back has none, and cannot be checked.
function findPathEnds(segments) {
  const counts = new Map();
  segments.forEach((segment) => {
    counts.set(segment.from, (counts.get(segment.from) || 0) + 1);
    counts.set(segment.to, (counts.get(segment.to) || 0) + 1);
  });
  const ends = [...counts].filter(([, count]) => count % 2 === 1).map(([node]) => node);
  return ends.length === 2 ? ends : null;
}

function stationsAgree(distances, item) {
  const near = distances.get(item.ends[0]);
  const far = distances.get(item.ends[1]);
  if (near === undefined || far === undefined) return false;
  const tolerance = Math.max(STATION_TOLERANCE_MIN_METRES, STATION_TOLERANCE_FRACTION * (item.high - item.low));
  return Math.abs(Math.min(near, far) - item.low) <= tolerance && Math.abs(Math.max(near, far) - item.high) <= tolerance;
}

// Sets item.station to "agree", "mismatch" or "unchecked" (no usable stations, no clean pair of ends, or
// the only confident row on its street, which has nothing to be fitted against).
function checkStations(items, index) {
  const groups = new Map();
  items.forEach((item) => {
    item.station = "unchecked";
    item.low = Number(item.row.losta) * FEET_TO_METRES;
    item.high = Number(item.row.hista) * FEET_TO_METRES;
    item.ends = findPathEnds(item.match.segments);
    if (!item.ends || !(item.high > item.low)) return;
    const key = item.row.parent || item.row.st_name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  groups.forEach((group) => {
    if (group.length < 2) return;
    const streetSegments = new Map();
    new Set(group.map((item) => item.row.st_name)).forEach((name) => findStreet(index, name).forEach((segment) => streetSegments.set(segment.id, segment)));
    const adjacency = buildAdjacency([...streetSegments.values()]);
    // The street's start is rarely the end of a row (Amory St's first row begins 900 ft in), so the
    // street's own leaves are candidates too.
    const origins = new Set([...group.flatMap((item) => item.ends), ...findLeafNodes([...streetSegments.values()])]);
    let best = null;
    origins.forEach((origin) => {
      const { distance } = shortestPaths(adjacency, origin, Infinity);
      const agreeing = group.filter((item) => stationsAgree(distance, item)).length;
      if (!best || agreeing > best.agreeing) best = { agreeing, distance };
    });
    group.forEach((item) => {
      item.station = stationsAgree(best.distance, item) ? "agree" : "mismatch";
    });
  });
}

// ---- The build ---------------------------------------------------------------------------------

function buildBostonCurbs({ rows, features }) {
  const report = {
    rows: rows.length,
    oddEvenRows: 0,
    confidentOddEvenRows: 0,
    confidentRows: 0,
    confidentLeafEndRows: 0,
    stations: { agree: 0, mismatch: 0, unchecked: 0 },
    confidentCheckedOddEvenRows: 0,
    confidentRatios: { within10: 0, within20: 0, wider: 0 },
    partialRows: 0,
    unpublishedRows: 0,
    unsupportedSideRows: 0,
    unreadableRows: 0,
    rowsEndingBeforeStart: [],
    statuses: {},
    ambiguousSideSegments: 0,
    curbs: 0,
    medianCurbs: 0,
    unpublished: []
  };
  const segments = readSegments(features);
  buildNodes(segments);
  const index = indexSegments(segments);
  const bySide = new Map();
  const accepted = [];

  rows.forEach((row) => {
    const label = readSideLabel(row.side);
    const isOddEven = label.parity && !label.median;
    if (isOddEven) report.oddEvenRows += 1;
    const record = (status, extra = {}) => {
      report.statuses[status] = (report.statuses[status] || 0) + 1;
      if (status !== "confident") {
        report.unpublished.push({ mainId: Number(row.main_id), street: row.st_name, from: row.from, to: row.to, side: row.side, status, ...extra });
      }
    };
    if (label.unsupported) {
      report.unsupportedSideRows += 1;
      record("unsupported-side");
      return;
    }
    const { schedule, reason, endsBeforeStart } = readSchedule(row);
    if (!schedule) {
      report.unreadableRows += 1;
      record(reason);
      return;
    }
    if (endsBeforeStart) report.rowsEndingBeforeStart.push({ mainId: schedule.mainId, street: row.st_name, start: schedule.start, end: schedule.end });
    const miles = Number(row.miles);
    if (!(miles > 0)) {
      record("no-length");
      return;
    }
    const match = matchRow(row, index, miles);
    if (match.status !== "confident") {
      if (match.status === "partial") report.partialRows += 1;
      else report.unpublishedRows += 1;
      record(match.status === "partial" ? `partial-${match.reason}` : match.status, { ratio: match.ratio ? Number(match.ratio.toFixed(2)) : undefined });
      return;
    }
    accepted.push({ row, label, schedule, match, isOddEven, record });
  });

  // The length band has passed; now the stations. A row that fails them is withdrawn, not published.
  checkStations(accepted, index);
  accepted.forEach(({ row, label, schedule, match, isOddEven, record, station }) => {
    report.stations[station] += 1;
    if (station === "mismatch") {
      report.unpublishedRows += 1;
      record("station-mismatch", { ratio: Number(match.ratio.toFixed(2)) });
      return;
    }
    report.confidentRows += 1;
    if (match.leafEnds?.length) report.confidentLeafEndRows += 1;
    const spread = Math.abs(match.ratio - 1);
    report.confidentRatios[spread <= 0.1 ? "within10" : spread <= 0.2 ? "within20" : "wider"] += 1;
    if (isOddEven) report.confidentOddEvenRows += 1;
    if (isOddEven && station === "agree") report.confidentCheckedOddEvenRows += 1;
    record("confident");

    match.segments.forEach((segment) => {
      const placements = label.both
        ? [{ side: 1 }, { side: -1 }]
        : [pickSide(segment, label.parity)];
      placements.forEach((placement) => {
        if (placement.guessed) report.ambiguousSideSegments += 1;
        const median = Boolean(label.median);
        const key = `${segment.id}|${placement.side}|${median}`;
        let curb = bySide.get(key);
        if (!curb) {
          const sideKey = getSideKey(segment.line, placement.side);
          const range = placement.side === 1 ? segment.addresses.left : segment.addresses.right;
          curb = {
            id: buildCurbId(segment.id, placement.side, median),
            street: segment.displayName,
            sideKey,
            ...(median ? { median: true } : {}),
            schedules: [],
            geometry: roundPath(median ? segment.line : offsetPath(segment.line, placement.side * CURB_OFFSET_METRES)),
            segmentId: segment.id,
            ...(range[0] && range[1] ? { addresses: [Math.min(range[0], range[1]), Math.max(range[0], range[1])] } : {})
          };
          bySide.set(key, curb);
        }
        curb.schedules.push(schedule);
      });
    });
  });

  const built = [...bySide.values()].map((curb) => ({ ...curb, schedules: mergeSchedules(curb.schedules) }));
  built.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const idsBySegment = new Map();
  built.forEach((curb) => {
    if (curb.median) return;
    if (!idsBySegment.has(curb.segmentId)) idsBySegment.set(curb.segmentId, []);
    idsBySegment.get(curb.segmentId).push(curb);
  });
  const curbs = built.map(({ segmentId, ...curb }) => {
    const partner = curb.median ? null : idsBySegment.get(segmentId).find((other) => other.id !== curb.id);
    return partner ? { ...curb, opposite: partner.id } : curb;
  });
  report.curbs = curbs.length;
  report.medianCurbs = curbs.filter((curb) => curb.median).length;
  report.curbsWithOpposite = curbs.filter((curb) => curb.opposite).length;
  report.curbsWithAddresses = curbs.filter((curb) => curb.addresses).length;
  report.overnightCurbs = curbs.filter((curb) => curb.schedules.some((schedule) => schedule.nightBefore)).length;
  report.standingCurbs = curbs.filter((curb) => curb.schedules.some((schedule) => schedule.standing)).length;
  report.confidentShare = report.oddEvenRows ? report.confidentOddEvenRows / report.oddEvenRows : 0;
  // The stricter figure: only rows whose stations were checked and agreed.
  report.confidentCheckedShare = report.oddEvenRows ? report.confidentCheckedOddEvenRows / report.oddEvenRows : 0;
  return { curbs, report };
}

module.exports = {
  CURB_OFFSET_METRES,
  NODE_SNAP_METRES,
  LENGTH_BAND_LOW,
  LENGTH_BAND_HIGH,
  METRES_PER_MILE,
  parseCsv,
  normalizeStreetName,
  formatStreetName,
  readSchedule,
  mergeSchedules,
  readSegments,
  buildNodes,
  indexSegments,
  findStreet,
  matchRow,
  checkStations,
  readSideLabel,
  pickSide,
  getSideKey,
  offsetPath,
  buildBostonCurbs
};
