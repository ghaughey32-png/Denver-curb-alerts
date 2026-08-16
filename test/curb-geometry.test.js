const test = require("node:test");
const assert = require("node:assert/strict");
const { getStreetOrientation, getRouteSideForCurb } = require("../public/curb-geometry.js");

test("S Knox curbs stop and bend around the Alameda/Morrison interchange", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /applySouthKnoxAlamedaInterchangeGeometry\(routeMap\)/);
  assert.match(app, /\[39\.7112642, -105\.0327527\]/);
  assert.match(app, /\[39\.711142, -105\.0326652\]/);
  assert.doesNotMatch(app, /const northPath = \[\s*\[39\.713378806876, -105\.032459730268\],\s*\[39\.7112103546447, -105\.032455517129\]/);
});

test("S Lowell omits the nonexistent fallback roadway between Evans and Warren", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  const builder = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../scripts/build-static-inventory.js"),
    "utf8"
  );

  const fallbackId = "unavailable-florida-evans-sheridan-federal-osm-16984766-176091629-176076121-0";
  assert.match(app, new RegExp(fallbackId));
  assert.match(app, /!suppressedFallbackRouteIds\.has\(route\.id\)/);
  assert.match(builder, new RegExp(`routeMap\\.delete\\("${fallbackId}"\\)`));
  assert.doesNotMatch(app, /way\.routeId === 2969/);
});

test("S Osceola Way Yale-to-Newton keeps the screenshot-confirmed weekly schedule", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  const builder = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../scripts/build-static-inventory.js"),
    "utf8"
  );

  for (const source of [app, builder]) {
    assert.match(source, /confirmSouthOsceolaWayYaleNewtonCoverage\(routeMap\)/);
    assert.match(source, /routeMap\.get\(3244\)/);
    assert.match(source, /East side: The 2nd week of the month\./);
    assert.match(source, /West side: The 2nd week of the month\./);
    assert.match(source, /no vehicle relocation required during sweeping week/i);
  }

  const duplicateFallbackId =
    "unavailable-evans-yale-sheridan-federal-osm-16985383-11429256142-176095986-0";
  assert.match(app, new RegExp(duplicateFallbackId));
  assert.match(app, /!suppressedFallbackRouteIds\.has\(route\.id\)/);
  assert.match(builder, new RegExp(`routeMap\\.delete\\("${duplicateFallbackId}"\\)`));
});
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
    (route) => !route.dataUnavailable && route.leftSweepDirection === "Left" && route.rightSweepDirection === "Right"
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

test("S Irving inside the Hooker/Julian circle keeps its confirmed Wednesday curbs", () => {
  const route = inventory.routes.find((entry) => entry.id === 19485);

  assert.ok(route);
  assert.equal(route.streetName, "S IRVING ST");
  assert.equal(route.from, "S HOOKER CIR/S JULIAN CIR");
  assert.equal(route.to, "S HOOKER CIR/S JULIAN CIR");
  assert.equal(route.leftSweepDirection, "East");
  assert.equal(route.rightSweepDirection, "West");
  assert.match(route.leftSweepingRule, /East side: The 3rd Wednesday/i);
  assert.match(route.rightSweepingRule, /West side: The 3rd Wednesday/i);
  assert.deepEqual(route.schedules, [
    { Date: "08/19/2026", Description: "East & West" },
    { Date: "09/16/2026", Description: "East & West" }
  ]);
  assert.equal(getStreetOrientation(route.map.path), "north-south");
  assert.equal(getRouteSideForCurb(route.map.path, "east"), "left");
  assert.equal(getRouteSideForCurb(route.map.path, "west"), "right");
});

test("S Irving confirmed carriageways suppress their obsolete pink fallbacks", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");

  assert.match(app, /removeSupersededSouthIrvingFallbacks\(routeMap\)/);
  assert.match(app, /routeMap\.has\(5886\).*routeMap\.has\(19485\)/s);
  assert.match(app, /346396116-176092448-176092450-0/);
  assert.match(app, /346396117-3529398385-3529398382-0/);
});

test("S Hooker Way keeps its east/west schedule through the Wesley curve", () => {
  const route = inventory.routes.find((entry) => entry.id === 8385);
  const obsoleteFallbackId = "unavailable-evans-yale-sheridan-federal-osm-16989337-176111335-176092444-0";

  assert.ok(route);
  assert.equal(route.streetName, "S HOOKER WAY");
  assert.match(route.leftSweepingRule, /East side: The 3rd week/i);
  assert.match(route.rightSweepingRule, /West side: The 3rd week/i);
  assert.equal(inventory.routes.some((entry) => entry.id === obsoleteFallbackId), false);
});

test("S Julian Circle uses its confirmed schedule and suppresses pink fallbacks", () => {
  const routes = [
    inventory.routes.find((entry) => entry.id === 8554),
    inventory.routes.find((entry) => entry.id === 20766)
  ];

  routes.forEach((route) => {
    assert.ok(route);
    assert.equal(route.streetName, "S JULIAN CIR");
    assert.match(route.leftSweepingRule, /East side: The 3rd Wednesday/i);
    assert.match(route.rightSweepingRule, /West side: The 3rd Tuesday/i);
    assert.deepEqual(route.schedules, [
      { Date: "08/18/2026", Description: "West" },
      { Date: "08/19/2026", Description: "East" },
      { Date: "09/15/2026", Description: "West" },
      { Date: "09/16/2026", Description: "East" }
    ]);
  });
  assert.equal(routes[0].from, "S IRVING ST/S HOOKER CIR");
  assert.equal(routes[0].to, "W ASBURY AVE");
  assert.equal(routes[1].from, "W ASBURY AVE");
  assert.equal(routes[1].to, "S IRVING ST/S HOOKER CIR");

  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /routeMap\.has\(8554\).*routeMap\.has\(20766\)/s);
  assert.match(app, /16988433-3529398385-176110563-0/);
  assert.match(app, /16988433-176110563-3529398382-0/);
});

test("S Julian Way carries route 19406's schedule through the Mexico name-change curve", () => {
  const official = inventory.routes.find((entry) => entry.id === 19406);
  assert.ok(official);
  assert.equal(official.from, "W IOWA AVE");
  assert.equal(official.to, "W MEXICO AVE/NMCHG");
  assert.match(official.leftSweepingRule, /East side: The 3rd Wednesday/i);
  assert.match(official.rightSweepingRule, /West side: The 3rd Tuesday/i);
  assert.deepEqual(official.schedules, [
    { Date: "08/18/2026", Description: "West" },
    { Date: "08/19/2026", Description: "East" },
    { Date: "09/15/2026", Description: "West" },
    { Date: "09/16/2026", Description: "East" }
  ]);

  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /addConfirmedSouthJulianWayCoverage\(routeMap\)/);
  assert.match(app, /confirmed-s-julian-way-iowa-mexico/);
  assert.match(app, /16989248-176076646-176104112-0/);
  assert.match(app, /39\.6853267, -105\.0317243/);
});

test("S Hazel Court Barr–Mexico replaces only its pink fallback with confirmed curb coverage", () => {
  const route = inventory.routes.find((entry) => entry.id === 4205);
  assert.ok(route);
  assert.equal(route.streetName, "S HAZEL CT");
  assert.equal(route.from, "BARR");
  assert.equal(route.to, "W MEXICO AVE");
  assert.match(route.leftSweepingRule, /East side: The 3rd Wednesday/i);
  assert.match(route.rightSweepingRule, /West side: The 3rd Tuesday/i);
  assert.deepEqual(route.schedules, [
    { Date: "08/18/2026", Description: "West" },
    { Date: "08/19/2026", Description: "East" },
    { Date: "09/15/2026", Description: "West" },
    { Date: "09/16/2026", Description: "East" }
  ]);

  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /confirmSouthHazelBarrMexicoCoverage\(routeMap\)/);
  assert.match(app, /routeMap\.get\(4205\)/);
  assert.match(app, /1182706968-176104107-176112227-0/);
  assert.match(app, /fallbackRoute\.map\.path\.slice\(\)\.reverse\(\)/);
});

test("the diagonal Perry-labeled fallback is confirmed S Patton Court", () => {
  const route = inventory.routes.find((entry) => entry.id === 18232);
  assert.ok(route);
  assert.equal(route.streetName, "S PATTON CT");
  assert.equal(route.from, "W EXPOSITION AVE/S PERRY ST");
  assert.equal(route.to, "WYE");
  assert.match(route.leftSweepingRule, /East side: The 3rd Tuesday/i);
  assert.match(route.rightSweepingRule, /West side: The 3rd Wednesday/i);
  assert.deepEqual(route.schedules, [
    { Date: "08/18/2026", Description: "East" },
    { Date: "08/19/2026", Description: "West" },
    { Date: "09/15/2026", Description: "East" },
    { Date: "09/16/2026", Description: "West" }
  ]);

  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /addConfirmedSouthPattonWyeCoverage\(routeMap\)/);
  assert.match(app, /confirmed-s-patton-exposition-wye/);
  assert.match(app, /37273289-176106473-434298297-0/);
  assert.match(app, /streetName: "S PATTON CT"/);
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

  assert.equal(unavailable.length, 6);
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

test("26th includes confirmed scheduled Larimer-to-Blake coverage", () => {
  const route = inventory.routes.find((entry) => entry.id === 23947);
  assert.ok(route);
  assert.equal(route.from, "LARIMER ST");
  assert.equal(route.to, "BLAKE ST");
  assert.equal(route.sweepType, "Scheduled");
  assert.ok(route.map.path.length >= 2);
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

test("Walnut Street screenshot-confirmed blocks render as pink unavailable coverage", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /unavailable-walnut-29th-30th/);
  assert.match(app, /unavailable-walnut-31st-32nd/);
  assert.match(app, /unavailable-walnut-27th-28th/);
  assert.match(app, /unavailable-walnut-28th-29th/);
  assert.match(app, /markUnavailable\(24031, "LARIMER ST", "WALNUT ST"\)/);
  assert.match(app, /markUnavailable\(24033, "WALNUT ST", "BLAKE ST"\)/);
  assert.match(app, /Street Sweeping Schedules and Alerts lookup confirms an April–November sweeping season/);
});

test("34th Street Larimer-to-Walnut uses the screenshot-confirmed schedule", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /confirmed-34th-larimer-walnut/);
  assert.match(app, /adjacentId: 22787/);
  assert.match(app, /streetName: "34TH ST",\s+from: "LARIMER ST",\s+to: "WALNUT ST"/);
});

test("visible Walnut, Larimer, and connecting RiNo gaps receive pink coverage", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/app.js"), "utf8");
  for (const id of [
    "unavailable-walnut-30th-31st", "unavailable-walnut-32nd-33rd",
    "unavailable-walnut-33rd-34th", "unavailable-walnut-34th-35th",
    "unavailable-larimer-33rd-34th", "unavailable-larimer-34th-35th",
    "unavailable-35th-larimer-walnut"
  ]) assert.match(app, new RegExp(id));
});

test("W Maple railroad crossing to Pecos uses the verified city schedule", () => {
  const route = inventory.routes.find((entry) => entry.id === 4043);
  assert.ok(route);
  assert.equal(route.streetName, "W MAPLE AVE");
  assert.equal(route.from, "RRX");
  assert.equal(route.to, "S PECOS ST");
  assert.match(route.leftSweepingRule, /South side: The 2nd Thursday/i);
  assert.match(route.rightSweepingRule, /North side: The 2nd Friday/i);
  assert.deepEqual(route.map.path[0], [39.7139480704729, -105.004865723319]);
});

test("S Pecos from Arizona to Louisiana uses the screenshot-confirmed schedule", () => {
  const route = inventory.routes.find((entry) => entry.id === 3457);
  assert.ok(route);
  assert.equal(route.streetName, "S PECOS ST");
  assert.equal(route.from, "W ARIZONA AVE");
  assert.equal(route.to, "W LOUISIANA AVE");
  assert.equal(route.sweepType, "Scheduled");
  assert.match(route.leftSweepingRule, /East side: The 2nd Wednesday/i);
  assert.match(route.rightSweepingRule, /West side: The 2nd Tuesday/i);
  assert.deepEqual(route.schedules, [
    { Date: "09/08/2026", Description: "West" },
    { Date: "09/09/2026", Description: "East" }
  ]);
  assert.equal(route.isPosted, true);
});

test("S Pecos at Evans extends confirmed coverage north of Pacific without pink curbs", () => {
  const routes = inventory.routes;
  const route = routes.find((candidate) => candidate.id === 27084);
  const obsoleteFallbackId =
    "unavailable-florida-yale-federal-i25-osm-37290027-176110603-176106054-0";

  assert.ok(route);
  assert.equal(route.streetName, "S PECOS ST");
  assert.equal(route.to, "W EVANS AVE");
  assert.deepEqual(route.map.path[0], [39.679963, -105.0063528]);
  assert.deepEqual(route.map.path.at(-1), [39.6785885471175, -105.006408678511]);
  assert.match(route.leftSweepingRule, /East side: The 2nd Wednesday/i);
  assert.match(route.rightSweepingRule, /West side: The 2nd Tuesday/i);
  assert.equal(routes.some((candidate) => candidate.id === obsoleteFallbackId), false);
});

test("Valverde pink sections use the confirmed Bayaud and Navajo schedules", () => {
  const bayaud = inventory.routes.find((entry) => entry.id === "confirmed-w-bayaud-platte-navajo");
  assert.ok(bayaud);
  assert.match(bayaud.leftSweepingRule, /South side: The 2nd Friday/i);
  assert.match(bayaud.rightSweepingRule, /North side: The 2nd Thursday/i);

  const navajo = inventory.routes.find((entry) => entry.id === "confirmed-s-navajo-bayaud-maple");
  assert.ok(navajo);
  assert.equal(navajo.sweepType, "Weekly");
  assert.match(navajo.leftSweepingRule, /East side: The 2nd week/i);
  assert.match(navajo.rightSweepingRule, /West side: The 2nd week/i);
  assert.equal(navajo.isPosted, false);
});

test("S Navajo through Byers and W Cedar park frontage use confirmed schedules", () => {
  for (const id of ["confirmed-s-navajo-maple-cedar", "confirmed-s-navajo-cedar-byers"]) {
    const route = inventory.routes.find((entry) => entry.id === id);
    assert.ok(route, `${id} is present`);
    assert.equal(route.sweepType, "Weekly");
    assert.match(route.leftSweepingRule, /East side: The 2nd week/i);
    assert.match(route.rightSweepingRule, /West side: The 2nd week/i);
    assert.equal(route.isPosted, false);
  }

  const cedar = inventory.routes.find((entry) => entry.id === "confirmed-w-cedar-platte-lipan-navajo");
  assert.ok(cedar);
  assert.match(cedar.leftSweepingRule, /South side: The 2nd Friday/i);
  assert.match(cedar.rightSweepingRule, /North side: The 2nd Thursday/i);
});

test("W 50th and Vrain infill uses Denver's official routes and endpoints", () => {
  const west50 = inventory.routes.find((entry) => entry.id === 11791);
  assert.ok(west50);
  assert.equal(west50.streetName, "W 50TH AVE");
  assert.equal(west50.from, "N VRAIN ST");
  assert.equal(west50.to, "END");
  assert.match(west50.leftSweepingRule, /South side: The 4th Friday/i);
  assert.match(west50.rightSweepingRule, /North side: The 4th Thursday/i);

  const vrain = inventory.routes.find((entry) => entry.id === 240);
  assert.ok(vrain);
  assert.equal(vrain.streetName, "N VRAIN ST");
  assert.equal(vrain.sweepType, "Private");
  assert.match(vrain.leftSweepingRule, /not maintained by the City and County of Denver/i);

  const west50Remainder = inventory.routes.find((entry) => entry.expectedBlockId === "w50-vrain-infill-osm-w50-beyond-denver-end");
  assert.ok(west50Remainder);
  assert.equal(west50Remainder.dataUnavailable, true);
  assert.match(west50Remainder.leftSweepingRule, /check posted signs/i);
  assert.deepEqual(west50Remainder.map.path[0], west50.map.path.at(-1));
  assert.deepEqual(vrain.map.path.at(-1), [39.7886871, -105.0462386]);
  assert.equal(inventory.routes.some((entry) => entry.expectedBlockId === "w50-vrain-infill-osm-vrain-beyond-denver-end"), false);
});
