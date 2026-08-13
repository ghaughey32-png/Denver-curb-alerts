const test = require("node:test");
const assert = require("node:assert/strict");
const { getStreetOrientation, getRouteSideForCurb } = require("../public/curb-geometry.js");
const inventory = require("../public/denver-west-routes.json");

test("maps northeast-bound Boulder Street left/right onto its displayed curbs", () => {
  const boulderStreet = [
    [39.7584085979085, -105.011814054771],
    [39.762041001565, -105.00689955967]
  ];

  assert.equal(getStreetOrientation(boulderStreet), "east-west");
  assert.equal(getRouteSideForCurb(boulderStreet, "north"), "left");
  assert.equal(getRouteSideForCurb(boulderStreet, "south"), "right");
});

test("respects route ordering for east-west streets", () => {
  assert.equal(getRouteSideForCurb([[39.7, -105.1], [39.7, -105.0]], "north"), "left");
  assert.equal(getRouteSideForCurb([[39.7, -105.0], [39.7, -105.1]], "north"), "right");
});

test("respects route ordering for north-south streets", () => {
  assert.equal(getRouteSideForCurb([[39.7, -105.0], [39.8, -105.0]], "west"), "left");
  assert.equal(getRouteSideForCurb([[39.8, -105.0], [39.7, -105.0]], "west"), "right");
});

test("assigns every current Left/Right Denver route to opposite displayed curbs", () => {
  const leftRightRoutes = inventory.routes.filter(
    (route) => route.leftSweepDirection === "Left" && route.rightSweepDirection === "Right"
  );

  assert.ok(leftRightRoutes.length > 0);
  leftRightRoutes.forEach((route) => {
    const orientation = getStreetOrientation(route.map.path);
    const curbKeys = orientation === "east-west" ? ["north", "south"] : ["east", "west"];
    assert.deepEqual(
      new Set(curbKeys.map((sideKey) => getRouteSideForCurb(route.map.path, sideKey))),
      new Set(["left", "right"]),
      `route ${route.id} ${route.streetName}`
    );
  });
});

test("W 11th Gateway North coverage joins the adjacent official endpoints", () => {
  const westRoute = inventory.routes.find((route) => route.id === 5187);
  const eastRoute = inventory.routes.find((route) => route.id === 18240);
  const coveragePath = [
    [39.7338791010489, -105.023379744091],
    [39.7338784, -105.02256],
    [39.7338776268528, -105.021747711029]
  ];

  assert.ok(westRoute);
  assert.ok(eastRoute);
  assert.deepEqual(coveragePath[0], westRoute.map.path[0]);
  assert.deepEqual(coveragePath.at(-1), eastRoute.map.path.at(-1));
  assert.equal(westRoute.leftSweepingRule, eastRoute.leftSweepingRule);
  assert.equal(westRoute.rightSweepingRule, eastRoute.rightSweepingRule);
  assert.equal(getRouteSideForCurb(coveragePath, "north"), "left");
  assert.equal(getRouteSideForCurb(coveragePath, "south"), "right");
});

test("W 20th changes to W Lakeshore at the alley between Quitman and Raleigh", () => {
  const west20 = inventory.routes.find((route) => route.id === "28451-w-20th");
  const lakeshore = inventory.routes.find((route) => route.id === "28451-w-lakeshore");
  assert.ok(west20);
  assert.ok(lakeshore);
  assert.equal(west20.streetName, "W 20TH AVE");
  assert.equal(west20.from, "N QUITMAN ST");
  assert.match(west20.to, /ALLEY/);
  assert.equal(lakeshore.streetName, "W LAKESHORE DR");
  assert.match(lakeshore.from, /ALLEY/);
  assert.equal(lakeshore.to, "N RALEIGH ST");
  assert.deepEqual(west20.map.path.at(-1), lakeshore.map.path[0]);
  assert.equal(west20.officialRouteId, 28451);
  assert.equal(lakeshore.officialRouteId, 28451);
});

test("RiNo inventory covers Blake through Arapahoe and 27th through 33rd", () => {
  const routeNames = new Set(inventory.routes.map((route) => route.streetName));

  ["BLAKE ST", "LARIMER ST", "LAWRENCE ST", "ARAPAHOE ST"].forEach((streetName) => {
    assert.ok(routeNames.has(streetName), `${streetName} is present`);
  });
  ["27TH ST", "28TH ST", "29TH ST", "30TH ST", "31ST ST", "32ND ST", "33RD ST"].forEach((streetName) => {
    assert.ok(routeNames.has(streetName), `${streetName} is present`);
  });

  const targetRoutes = inventory.routes.filter((route) => {
    const center = route.map?.center;
    return center && center[0] >= 39.7545 && center[0] <= 39.768 && center[1] >= -104.989 && center[1] <= -104.968;
  });
  assert.ok(targetRoutes.length >= 100, "the RiNo grid has block-level route coverage");
  targetRoutes.forEach((route) => {
    assert.ok(route.leftSweepingRule || route.rightSweepingRule, `route ${route.id} includes sweeping information`);
  });
});

test("Larimer Broadway–33rd has explicit clickable unavailable-data coverage", () => {
  const unavailable = inventory.routes.filter(
    (route) => route.streetName === "LARIMER ST" && route.dataUnavailable
  );

  assert.equal(unavailable.length, 9);
  assert.ok(unavailable.some((route) => route.from === "N BROADWAY/TRAFFIC SIGNAL" && route.to === "25TH ST"));
  assert.ok(unavailable.some((route) => route.from === "26TH ST" && route.to === "27TH ST"));
  assert.ok(unavailable.some((route) => route.from === "32ND ST" && route.to === "33RD ST"));
  unavailable.forEach((route) => {
    assert.equal(route.sweepType, "Unavailable");
    assert.match(route.leftSweepingRule, /check posted signs/i);
    assert.ok(route.map.path.length >= 2);
  });
});

test("27th Street official route is continuous from Larimer through Blake to Walnut", () => {
  const route = inventory.routes.find((entry) => entry.id === 24018);
  assert.ok(route);
  assert.equal(route.from, "LARIMER ST");
  assert.equal(route.to, "WALNUT ST");
  assert.deepEqual(route.map.path[0], [39.7595021964107, -104.984128022484]);
  assert.deepEqual(route.map.path.at(-1), [39.7608300127708, -104.985886980374]);
  assert.match(route.leftSweepingRule, /4th Friday/i);
  assert.match(route.rightSweepingRule, /4th Thursday/i);
});

test("26th and 28th include confirmed scheduled Larimer-to-Blake blocks", () => {
  for (const [id, streetName] of [[23947, "26TH ST"], [24031, "28TH ST"]]) {
    const route = inventory.routes.find((entry) => entry.id === id);
    assert.ok(route, `${streetName} missing block is present`);
    assert.equal(route.from, "LARIMER ST");
    assert.equal(route.to, "BLAKE ST");
    assert.equal(route.sweepType, "Scheduled");
    assert.match(route.leftSweepingRule, /4th Thursday/i);
    assert.match(route.rightSweepingRule, /4th Friday/i);
    assert.ok(route.map.path.length >= 2);
  }
});

test("29th through 33rd represent all confirmed Larimer-to-Blake coverage", () => {
  for (const id of [24034, 22697, 22708, 22784]) {
    const route = inventory.routes.find((entry) => entry.id === id);
    assert.ok(route);
    assert.equal(route.from, "LARIMER ST");
    assert.equal(route.to, "BLAKE ST");
    assert.equal(route.sweepType, "Scheduled");
  }
  const route31 = inventory.routes.find((entry) => entry.id === 12099);
  const unresolved31 = inventory.routes.find((entry) => entry.id === "unavailable-31st-end-blake");
  assert.equal(route31.to, "END");
  assert.equal(route31.sweepType, "Scheduled");
  assert.equal(unresolved31.dataUnavailable, true);
  assert.match(unresolved31.leftSweepingRule, /check posted signs/i);
});
