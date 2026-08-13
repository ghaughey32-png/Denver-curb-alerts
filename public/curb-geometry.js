(function attachCurbGeometry(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.CurbGeometry = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function buildCurbGeometry() {
  function getRouteVector(points) {
    if (!Array.isArray(points) || points.length < 2) {
      return { east: 0, north: 0 };
    }

    const [firstLat, firstLon] = points[0];
    const [lastLat, lastLon] = points[points.length - 1];
    const averageLatitude = ((firstLat + lastLat) / 2) * (Math.PI / 180);

    return {
      east: (lastLon - firstLon) * Math.cos(averageLatitude),
      north: lastLat - firstLat
    };
  }

  function getStreetOrientation(points) {
    const vector = getRouteVector(points);
    return Math.abs(vector.east) >= Math.abs(vector.north) ? "east-west" : "north-south";
  }

  // Denver's Left/Right values are relative to the ordered route geometry.
  // Compare the requested map curb with the vector perpendicular to that route.
  function getRouteSideForCurb(points, sideKey) {
    const vector = getRouteVector(points);
    const requestedVector = {
      north: { east: 0, north: 1 },
      south: { east: 0, north: -1 },
      east: { east: 1, north: 0 },
      west: { east: -1, north: 0 }
    }[sideKey];

    if (!requestedVector || (vector.east === 0 && vector.north === 0)) {
      return null;
    }

    const leftVector = { east: -vector.north, north: vector.east };
    const leftDotProduct = leftVector.east * requestedVector.east + leftVector.north * requestedVector.north;
    return leftDotProduct >= 0 ? "left" : "right";
  }

  return { getRouteVector, getStreetOrientation, getRouteSideForCurb };
});
