function applyConfirmedVrainCoverage(routeMap) {
  const route = routeMap.get(240);
  if (!route) return;

  const path = [
    [39.7874346722034, -105.046236514678],
    [39.7885553866327, -105.046231929618],
    [39.7886871, -105.0462386]
  ];
  routeMap.set(240, {
    ...route,
    from: "W 50TH AVE",
    to: "END",
    map: { ...route.map, staticMapUrl: "", center: path[1], path },
    sourceNote: "Full W 50th Ave–END geometry confirmed from Denver's Street Sweeping Schedules and Alerts result; both sides are not maintained by the City and County of Denver."
  });
}

module.exports = { applyConfirmedVrainCoverage };
