// The City of Glendale is an independent municipality of about half a square
// mile, entirely surrounded by Denver, sitting between Colorado Boulevard and
// South Cherry Street either side of Cherry Creek. Denver's sweeping API knows
// nothing about its streets, so every Glendale block comes back unmatched.
//
// Publishing those blocks as pink "schedule unavailable" overlays would be
// worse than leaving them out: pink tells the user they do not need to move
// their car, and Glendale runs its own posted street sweeping and writes its
// own tickets. Excluding them keeps the map honest about where Denver's data
// actually applies, the same way the Denver–Commerce City line at Sand Creek is
// handled in scripts/import-osm-expected-blocks.js.
//
// The ring is the outer way of OpenStreetMap relation 112942 (boundary=
// administrative, admin_level=8, name=Glendale), stitched into a single closed
// polygon and rounded to six decimals — about 0.1 m, far finer than the 8 m
// sampling the coverage audit uses.
const GLENDALE_CITY_LIMITS = [
  [39.701285, -104.932923], [39.700285, -104.932919], [39.700162, -104.932920],
  [39.700162, -104.934079], [39.698442, -104.933973], [39.698441, -104.931826],
  [39.700220, -104.931820], [39.700220, -104.931786], [39.700221, -104.931654],
  [39.700220, -104.930790], [39.700227, -104.929547], [39.700227, -104.929444],
  [39.700230, -104.928953], [39.700231, -104.928767], [39.698420, -104.928772],
  [39.698416, -104.928204], [39.697581, -104.928209], [39.696575, -104.928216],
  [39.696543, -104.933953], [39.696535, -104.936195], [39.696106, -104.936192],
  [39.695961, -104.936191], [39.694754, -104.936183], [39.694745, -104.937601],
  [39.694764, -104.939519], [39.695410, -104.939522], [39.695405, -104.940478],
  [39.694761, -104.940477], [39.694765, -104.940625], [39.695674, -104.940621],
  [39.696542, -104.940610], [39.696535, -104.939552], [39.696637, -104.939549],
  [39.696635, -104.938563], [39.697933, -104.938571], [39.697932, -104.940021],
  [39.697728, -104.940017], [39.697729, -104.940753], [39.698563, -104.940743],
  [39.703652, -104.940699], [39.704907, -104.940695], [39.706020, -104.940735],
  [39.707456, -104.940713], [39.709301, -104.940706], [39.711115, -104.940708],
  [39.711105, -104.935871], [39.711106, -104.935788], [39.711112, -104.931644],
  [39.709213, -104.931635], [39.708759, -104.929985], [39.708677, -104.929585],
  [39.708545, -104.928937], [39.708206, -104.927029], [39.708039, -104.927033],
  [39.708483, -104.929543], [39.706431, -104.929539], [39.706432, -104.929140],
  [39.706809, -104.929139], [39.706802, -104.928283], [39.706708, -104.928282],
  [39.706700, -104.927019], [39.705202, -104.927010], [39.703842, -104.927001],
  [39.703823, -104.929549], [39.703838, -104.931643], [39.702020, -104.931677],
  [39.702021, -104.932858], [39.703758, -104.932858], [39.703750, -104.934007],
  [39.701287, -104.934011], [39.701285, -104.932923], [39.701267, -104.928120],
  [39.701268, -104.929138], [39.701268, -104.929335], [39.702111, -104.929331],
  [39.702109, -104.929037], [39.701267, -104.928120], [39.701285, -104.932923]];

// Standard ray casting. Points are [lat, lon], matching the geometry arrays the
// importer emits; the ray is cast in the longitude direction at a fixed
// latitude, so the coordinate order only has to stay consistent with the ring.
function isPointInsideGlendale([latitude, longitude]) {
  let inside = false;
  for (let index = 0, previous = GLENDALE_CITY_LIMITS.length - 1; index < GLENDALE_CITY_LIMITS.length; previous = index++) {
    const [currentLat, currentLon] = GLENDALE_CITY_LIMITS[index];
    const [previousLat, previousLon] = GLENDALE_CITY_LIMITS[previous];
    const straddles = currentLat > latitude !== previousLat > latitude;
    if (!straddles) continue;
    const crossing = ((previousLon - currentLon) * (latitude - currentLat)) / (previousLat - currentLat) + currentLon;
    if (longitude < crossing) inside = !inside;
  }
  return inside;
}

// Metres per degree at Glendale's latitude, good to a fraction of a percent over
// a polygon this small.
const METRES_PER_DEGREE_LATITUDE = 111320;
const METRES_PER_DEGREE_LONGITUDE = 85700;

function metresToSegment([latitude, longitude], [aLat, aLon], [bLat, bLon]) {
  const x = (longitude - aLon) * METRES_PER_DEGREE_LONGITUDE;
  const y = (latitude - aLat) * METRES_PER_DEGREE_LATITUDE;
  const dx = (bLon - aLon) * METRES_PER_DEGREE_LONGITUDE;
  const dy = (bLat - aLat) * METRES_PER_DEGREE_LATITUDE;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
  return Math.hypot(x - t * dx, y - t * dy);
}

function metresInsideGlendale(point) {
  if (!isPointInsideGlendale(point)) return 0;
  let nearest = Infinity;
  for (let index = 0, previous = GLENDALE_CITY_LIMITS.length - 1; index < GLENDALE_CITY_LIMITS.length; previous = index++) {
    nearest = Math.min(nearest, metresToSegment(point, GLENDALE_CITY_LIMITS[index], GLENDALE_CITY_LIMITS[previous]));
  }
  return nearest;
}

// Glendale's boundary is drawn down the middle of the streets that ring it —
// Colorado Boulevard, South Cherry Street, East Mississippi Avenue — and Denver
// sweeps its own side of every one of them. A plain inside/outside test puts
// roughly half the sampled points of those streets in Glendale and throws away
// real Denver coverage, so a block only counts as Glendale's when most of it
// sits well clear of the line. Twenty metres is wider than any half-roadway on
// the boundary and far narrower than the shortest interior block.
const BOUNDARY_BUFFER_METRES = 20;

function isGlendaleBlock(geometry) {
  if (!Array.isArray(geometry) || !geometry.length) return false;
  const wellInside = geometry.filter((point) => metresInsideGlendale(point) > BOUNDARY_BUFFER_METRES).length;
  return wellInside * 2 > geometry.length;
}

// The same question without the buffer, for the one caller that can afford to
// ask it: scripts/sync-city-limits.js, running after the crawl.
//
// The buffer above is not conservatism, it is necessity at import time — the
// ring is drawn down the middle of Colorado Boulevard, South Cherry Street and
// East Mississippi Avenue, so Denver's own curb on all three falls *inside* it.
// Measured 2026-08-25: 29 blocks that Denver returns real sweeping schedules
// for have every sampled point inside this ring, at a median depth of 5.6 m,
// against 5.8 m for the Glendale side streets. The two are geometrically
// indistinguishable. No threshold separates them, and lowering the buffer to
// catch Glendale's grid would throw away Denver's boulevard coverage.
//
// What separates them is Denver's own answer. A block with a sweeping schedule
// is Denver's whatever the ring says; a block Denver returns nothing for, that
// sits inside Glendale by the plain test, is Glendale's. That evidence does not
// exist when the importer runs, which is why this predicate is not used there.
function isInsideGlendaleUnbuffered(geometry) {
  if (!Array.isArray(geometry) || !geometry.length) return false;
  const inside = geometry.filter((point) => isPointInsideGlendale(point)).length;
  return inside * 2 > geometry.length;
}

// One wording for the flag, wherever it is stamped. import-osm-expected-blocks.js
// applies it as an area arrives and sync-city-limits.js retroactively; a report
// that spells the reason two ways reads like two different rules.
const GLENDALE_EXCLUSION_REASON = "Inside the City of Glendale, which Denver does not sweep";

module.exports = {
  GLENDALE_CITY_LIMITS,
  GLENDALE_EXCLUSION_REASON,
  isPointInsideGlendale,
  metresInsideGlendale,
  isGlendaleBlock,
  isInsideGlendaleUnbuffered
};
