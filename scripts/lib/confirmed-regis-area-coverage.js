const NOT_MAINTAINED = "Street is not maintained by the City and County of Denver.";

function makeNotMaintainedRoute({ id, streetName, from, to, path, sourceNote }) {
  const horizontal = Math.abs(path.at(-1)[1] - path[0][1]) >= Math.abs(path.at(-1)[0] - path[0][0]);
  const left = horizontal ? "South" : "West";
  const right = horizontal ? "North" : "East";
  return {
    id,
    streetName,
    from,
    to,
    sweepType: "Private",
    leftSweepDirection: left,
    rightSweepDirection: right,
    leftSweepingRule: `${left} side: No schedules: ${NOT_MAINTAINED}`,
    rightSweepingRule: `${right} side: No schedules: ${NOT_MAINTAINED}`,
    schedules: [],
    isPosted: false,
    subscriptions: {},
    map: { staticMapUrl: "", center: path[Math.floor(path.length / 2)], path },
    sourceNote
  };
}

const routes = [
  {
    id: "not-maintained-parkside-east",
    streetName: "W PARKSIDE PL",
    from: "N DECATUR ST",
    to: "N CLAY PL",
    path: [[39.7921632, -105.0215113], [39.7921462, -105.021407], [39.7921268, -105.0212691], [39.7921247, -105.0206636]],
    sourceNote: "This extension is absent from Denver's street centerline inventory; mapped as a private development road in OpenStreetMap."
  },
  {
    id: "not-maintained-decatur-52-parkside",
    streetName: "N DECATUR ST",
    from: "W 52ND AVE",
    to: "W PARKSIDE PL",
    path: [[39.7910971855129, -105.021629467587], [39.7911762788004, -105.021645939647], [39.791840738216, -105.021637160615]],
    sourceNote: "Denver Street Centerline classifies both jurisdiction and maintenance as PRIVATE."
  },
  {
    id: "not-maintained-clay-place",
    streetName: "N CLAY PL",
    from: "W 52ND AVE",
    to: "W PARKSIDE PL",
    path: [[39.7910977, -105.0206226], [39.7913799, -105.0206208], [39.7920878, -105.0206162], [39.7921247, -105.0206636]],
    sourceNote: "Absent from Denver's street centerline inventory; mapped as an internal development road in OpenStreetMap."
  },
  {
    id: "not-maintained-decatur-parkside-53",
    streetName: "N DECATUR ST",
    from: "W PARKSIDE PL",
    to: "W 53RD AVE",
    path: [[39.7921632, -105.0215113], [39.7923178, -105.0214819], [39.7924339, -105.0215143], [39.7925687, -105.0216036]],
    sourceNote: "Absent from Denver's street centerline inventory; mapped as an internal development road in OpenStreetMap."
  },
  {
    id: "not-maintained-west-53-inner",
    streetName: "W 53RD AVE",
    from: "N ELIOT ST",
    to: "N DECATUR ST",
    path: [[39.7925673, -105.024181], [39.7927053, -105.0239549], [39.7927654, -105.0235687], [39.7927181, -105.0232227], [39.7926559, -105.0227836], [39.7927332, -105.0221977], [39.7927008, -105.0218444], [39.7925687, -105.0216036]],
    sourceNote: "Absent from Denver's street centerline inventory; mapped as an internal development road in OpenStreetMap."
  },
  {
    id: "not-maintained-eliot-parkside-53",
    streetName: "N ELIOT ST",
    from: "W PARKSIDE PL",
    to: "W 53RD AVE",
    path: [[39.791933, -105.0239496], [39.7921644, -105.0239897], [39.7923365, -105.0241238], [39.7924905, -105.0242031], [39.7925673, -105.024181]],
    sourceNote: "Absent from Denver's street centerline inventory; mapped as an internal development road in OpenStreetMap."
  },
  {
    id: "not-maintained-primrose-lane",
    streetName: "N PRIMROSE LN",
    from: "W 53RD AVE",
    to: "W 54TH AVE",
    path: [[39.7934001, -105.0231912], [39.793914, -105.022997], [39.79463, -105.022741], [39.795062, -105.022283], [39.795511, -105.021492], [39.795843, -105.020628]],
    sourceNote: "Absent from Denver's street centerline inventory; mapped as an internal development road in OpenStreetMap."
  },
  {
    id: "not-maintained-columbine-road",
    streetName: "COLUMBINE RD",
    from: "N FEDERAL BLVD",
    to: "N PRIMROSE LN",
    path: [[39.7940352, -105.0251531], [39.7940712, -105.0246617], [39.793989, -105.02424], [39.793714, -105.023831], [39.793499, -105.023549], [39.793395, -105.023134], [39.793495, -105.022614], [39.7938353, -105.0221543], [39.794351, -105.021878], [39.794725, -105.021732], [39.795075, -105.020624]],
    sourceNote: "Denver Street Centerline classifies Columbine Road as Adams County jurisdiction and maintenance."
  }
];

function applyConfirmedRegisAreaCoverage(routeMap) {
  routes.forEach((definition) => routeMap.set(definition.id, makeNotMaintainedRoute(definition)));
}

module.exports = { applyConfirmedRegisAreaCoverage };
