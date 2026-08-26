// Trims the published inventory down to what the client actually reads.
//
// Every visitor downloads this payload before the map can draw, so a field the client never
// touches is pure latency. Measured on the 2026-08-26 payload, 19,702 routes came to 18.8 MB
// on the wire, of which the geometry that draws the map -- map.path -- was 2.3 MB. The two
// fields below accounted for 5.75 MB between them and were read by nothing:
//
//   map.staticMapUrl (3.90 MB)  Denver embeds route geometry in a Google staticmap URL, which
//                               parseStaticMapGeometry in server.js turns into map.path at crawl
//                               time. The URL has done its job by then; the client never reads
//                               it, and every coverage patch in the pipeline writes it as "".
//   subscriptions    (1.85 MB)  Denver's own subscription bookkeeping. The app has its own push
//                               subscriptions behind /api/push/subscriptions and never reads this.
//
// Coordinates are rounded to seven decimals, about 1.1 cm. Denver returns up to 13, and those
// trailing digits are nearly incompressible: rounding takes the gzipped payload from 1152 KB to
// 886 KB on its own.
//
// Seven and not six, which would save a further 65 KB. The auditor matches a block to a route by
// sampling every 8 m and accepting anything within 12 m, and some blocks sit within centimetres
// of that threshold -- Belleview at S Niagara is 11.9 m from the pink route on the far side of
// the divided avenue, and six decimals (11 cm) tipped it from `unavailable` to `unexplained-gap`.
// Seven decimals reclassifies nothing: verified block-for-block over all 20,979 public blocks
// against the unrounded payload. Re-run that comparison before lowering this.
//
// Keep this the only place that decides what ships. Adding a field to the routes is fine; the
// client simply gets it. Removing one belongs here, with a note saying what proved it unread.

const COORDINATE_PRECISION = 7;

const roundCoordinate = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(COORDINATE_PRECISION))
    : value;

const roundPoint = (point) => (Array.isArray(point) ? point.map(roundCoordinate) : point);

function slimRouteForPublication(route) {
  if (!route || typeof route !== "object") {
    return route;
  }

  const { subscriptions, map, ...rest } = route;
  if (!map || typeof map !== "object") {
    return rest;
  }

  const { staticMapUrl, center, path, ...restOfMap } = map;
  const slimMap = { ...restOfMap };
  if (center !== undefined) {
    slimMap.center = roundPoint(center);
  }
  if (path !== undefined) {
    slimMap.path = Array.isArray(path) ? path.map(roundPoint) : path;
  }

  return { ...rest, map: slimMap };
}

function slimRoutesForPublication(routes) {
  return (Array.isArray(routes) ? routes : []).map(slimRouteForPublication);
}

module.exports = { slimRouteForPublication, slimRoutesForPublication, COORDINATE_PRECISION };
