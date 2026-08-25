// The pipeline half of the city-limits rule. The geometry itself — the rings,
// the distance functions and the buffer — lives in public/denver-city-limits.js
// so that the map and this pipeline decide "is this Denver?" from one source.
// They did not always: the map drew its red wash from a live ArcGIS fetch of
// Denver's own boundary layer while the exclusion below used the OpenStreetMap
// rings, and the two disagreed over 589 published routes. See that file for the
// full account and for why the more authoritative ArcGIS layer is not the one
// both sides were moved to.
const {
  DENVER_CITY_LIMITS,
  BOUNDARY_BUFFER_METRES,
  isPointInsideDenver,
  metresOutsideDenver,
  isWithinDenver,
  getDenverMaskRings
} = require("../../public/denver-city-limits.js");

// A block counts as another city's only when most of it sits well clear of the
// line, because Denver's boundary runs down the middle of the streets that
// carry it and Denver sweeps its own side of every one. BOUNDARY_BUFFER_METRES
// and the reasoning behind its value are in public/denver-city-limits.js.
function isOutsideDenverBlock(geometry) {
  if (!Array.isArray(geometry) || !geometry.length) return false;
  const wellOutside = geometry.filter((point) => metresOutsideDenver(point) > BOUNDARY_BUFFER_METRES).length;
  return wellOutside * 2 > geometry.length;
}

// Is most of this block inside one of the city's enclaves -- Glendale, the Holly
// Hills pocket of Arapahoe County, the three smaller ones -- asked without the
// buffer? Only scripts/sync-city-limits.js may use this, and only together with
// Denver's own answer about whether it sweeps the block. See the note on
// isInsideGlendaleUnbuffered in glendale-city-limits.js for why the buffer
// cannot simply be lowered: an enclave's boundary runs down the middle of the
// streets that ring it, so Denver's own curb on those streets falls inside the
// ring and is geometrically indistinguishable from the enclave's side streets.
// A sweeping schedule is what tells them apart, and it does not exist at import
// time.
//
// Enclaves only. The outer city line is deliberately not asked about this way:
// past it the same ambiguity exists with no enclave to bound it, and the blocks
// it would catch are shared boundary streets where pink is often Denver's own.
function isInsideEnclaveUnbuffered(geometry) {
  if (!Array.isArray(geometry) || !geometry.length) return false;
  const inside = geometry.filter((point) =>
    DENVER_CITY_LIMITS.slice(1).some((ring) => pointInEnclaveRing(point, ring))
  ).length;
  return inside * 2 > geometry.length;
}

function pointInEnclaveRing([latitude, longitude], ring) {
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

// The wording every consumer stamps on a block it drops for this reason. Two
// scripts apply the same rule at different times -- the importer as an area
// arrives, sync-city-limits.js retroactively over areas imported before the
// rule existed -- and a coverage report that spells the reason two ways reads
// like two different rules.
const OUTSIDE_DENVER_EXCLUSION_REASON =
  "Outside the City and County of Denver, which sweeps only its own streets";

// Where along a -> b the path crosses in or out. The two endpoints are known to
// fall on opposite sides, and a straight block-length segment crosses the line
// once, so bisection converges on that crossing; twenty halvings put it well
// under a millimetre even on the longest segment in the manifest. Rounding to
// six decimals -- about 11 cm -- matches the precision of the ring itself and
// keeps the 9 MB payload from growing a full float per trimmed route.
function crossingPoint(a, b) {
  const startsInside = isWithinDenver(a);
  const at = (ratio) => [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
  let inside = 0;
  let outside = 1;
  for (let step = 0; step < 20; step += 1) {
    const middle = (inside + outside) / 2;
    if (isWithinDenver(at(middle)) === startsInside) inside = middle; else outside = middle;
  }
  const [latitude, longitude] = at((inside + outside) / 2);
  return [Number(latitude.toFixed(6)), Number(longitude.toFixed(6))];
}

// Dropping a whole block is the right answer when the block belongs to another
// city, but plenty of blocks only reach across the line -- a street that runs
// out of Denver mid-block, or one whose OSM way carries on past the city into
// Englewood. Those stay in the manifest, and the pink drawn for them used to
// run the full length of the way, which puts "you do not need to move your car"
// over curb another city sweeps and tickets. Trimming the geometry keeps the
// Denver half of the block clickable and stops drawing the rest.
//
// The cut is at the same 20 m buffer isOutsideDenverBlock uses, and for the
// same reason: the boundary runs down the middle of the streets that carry it,
// so a curb drawn on the centreline of East Hampden or South Yosemite sits a
// couple of metres either side of the line at random. Cutting at the line
// itself would shred those into dashes; cutting 20 m out leaves them whole.
//
// A path can leave Denver and come back -- East Cherry Creek South Drive clips
// the corner of Glendale, South Locust brushes the Holly Hills pocket -- so the
// result is a list of surviving pieces rather than one path. An empty list
// means nothing of the path was in Denver.
function clipPathToDenver(path) {
  if (!Array.isArray(path) || path.length < 2) return [];
  const pieces = [];
  let current = isWithinDenver(path[0]) ? [path[0]] : null;

  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const point = path[index];
    const previousInside = isWithinDenver(previous);
    const pointInside = isWithinDenver(point);
    if (previousInside && pointInside) current.push(point);
    else if (previousInside) {
      current.push(crossingPoint(previous, point));
      pieces.push(current);
      current = null;
    } else if (pointInside) current = [crossingPoint(previous, point), point];
  }
  if (current) pieces.push(current);

  return pieces.filter((piece) => piece.length > 1);
}

// Re-exported so every existing caller keeps requiring one module for the whole
// rule, geometry and policy together.
module.exports = {
  DENVER_CITY_LIMITS,
  BOUNDARY_BUFFER_METRES,
  OUTSIDE_DENVER_EXCLUSION_REASON,
  isPointInsideDenver,
  metresOutsideDenver,
  isWithinDenver,
  getDenverMaskRings,
  isOutsideDenverBlock,
  isInsideEnclaveUnbuffered,
  clipPathToDenver
};
