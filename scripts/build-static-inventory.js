const fs = require("fs/promises");
const path = require("path");

const APP_ORIGIN = process.env.APP_ORIGIN || "http://127.0.0.1:3000";
const OUTPUT_PATH = path.join(__dirname, "..", "public", "denver-west-routes.json");
const SCRIPT_OUTPUT_PATH = path.join(__dirname, "..", "public", "denver-west-routes.js");
const CONCURRENCY = 8;
const REQUIRED_ROUTE_ANCHORS = [
  // West 16th Avenue, Federal Boulevard–Grove Street. The broader grid's
  // nearest sample falls just outside Denver's lookup radius for this block.
  { latitude: 39.742738, longitude: -105.0262 },
  { latitude: 39.741, longitude: -105.039315 },
  { latitude: 39.7422, longitude: -105.039315 },
  { latitude: 39.7435, longitude: -105.039315 },
  { latitude: 39.741, longitude: -105.04283 },
  { latitude: 39.7422, longitude: -105.04283 },
  { latitude: 39.7435, longitude: -105.04283 },
  // Lowell Boulevard, 19th–26th Avenues. These also capture both
  // West 26th Avenue curb sections on either side of Lowell.
  { latitude: 39.746397, longitude: -105.03459 },
  { latitude: 39.747582, longitude: -105.0346 },
  { latitude: 39.748796, longitude: -105.03461 },
  { latitude: 39.749997, longitude: -105.03461 },
  { latitude: 39.751217, longitude: -105.03462 },
  { latitude: 39.752119, longitude: -105.03462 },
  { latitude: 39.753005, longitude: -105.03463 },
  { latitude: 39.753943, longitude: -105.03463 },
  { latitude: 39.754863, longitude: -105.03463 },
  // West 22nd Avenue, Eliot Street–Stuart Street.
  { latitude: 39.750003, longitude: -105.024417 },
  { latitude: 39.75, longitude: -105.026039 },
  { latitude: 39.75, longitude: -105.027481 },
  { latitude: 39.749996, longitude: -105.029356 },
  { latitude: 39.749996, longitude: -105.030741 },
  { latitude: 39.749999, longitude: -105.032188 },
  { latitude: 39.749999, longitude: -105.03403 },
  { latitude: 39.749994, longitude: -105.035206 },
  { latitude: 39.749991, longitude: -105.036384 },
  { latitude: 39.74999, longitude: -105.037559 },
  { latitude: 39.749986, longitude: -105.038728 },
  { latitude: 39.749972, longitude: -105.039896 },
  { latitude: 39.749966, longitude: -105.041075 },
  { latitude: 39.74997, longitude: -105.04224 },
  // Perry Street, West 20th–West 21st Avenues.
  { latitude: 39.7481, longitude: -105.03931 },
  // Osceola Street, West 23rd–West 26th Avenues.
  { latitude: 39.751673, longitude: -105.038143 },
  { latitude: 39.752579, longitude: -105.038138 },
  { latitude: 39.753474, longitude: -105.038144 },
  { latitude: 39.754395, longitude: -105.038145 },
  // Winona Court, West Byron Place–West 25th Avenue.
  { latitude: 39.75349, longitude: -105.04728 },
  // West Byron Place, Oak Street–Wolff Street.
  { latitude: 39.753041, longitude: -105.048166 },
  // West 17th Avenue: Perry–Stuart and Tennyson–Utica.
  { latitude: 39.74396, longitude: -105.041 },
  { latitude: 39.743972, longitude: -105.04459 },
  // West Conejos Place official city-scheduled blocks.
  { latitude: 39.74153, longitude: -105.04224 },
  { latitude: 39.74153, longitude: -105.04342 },
  { latitude: 39.74152, longitude: -105.0399 },
  { latitude: 39.74152, longitude: -105.03873 },
  { latitude: 39.741514, longitude: -105.03757 },
  { latitude: 39.741518, longitude: -105.03641 },
  { latitude: 39.741522, longitude: -105.03524 },
  { latitude: 39.741524, longitude: -105.034 },
  { latitude: 39.741519, longitude: -105.03213 },
  { latitude: 39.74152, longitude: -105.02932 },
  { latitude: 39.74152, longitude: -105.02744 }
];

const REGIONS = [
  { north: 39.7506, south: 39.7399, west: -105.0435, east: -105.0272, rows: 6, columns: 6 },
  { north: 39.74415, south: 39.7399, west: -105.05325, east: -105.04505, rows: 4, columns: 5 },
  { north: 39.7552, south: 39.7505, west: -105.05325, east: -105.02475, rows: 4, columns: 9 },
  // W 20th Avenue / Mile High Stadium Circle–W 26th Avenue,
  // Federal Boulevard–Bryant Street.
  { north: 39.75535, south: 39.74845, west: -105.02515, east: -105.01835, rows: 7, columns: 6 },
  // W 26th–W 32nd Avenue, Sheridan Boulevard–Federal Boulevard.
  // The staggered grid produced by sampleRegion checks roughly every street block.
  { north: 39.7623, south: 39.75465, west: -105.05325, east: -105.02475, rows: 8, columns: 13 },
  // W 26th–W 32nd Avenue, Federal Boulevard–Pecos Street / I-25.
  { north: 39.7623, south: 39.75465, west: -105.02515, east: -105.00615, rows: 8, columns: 13 },
  // W 32nd–W 38th Avenue, Sheridan Boulevard–Federal Boulevard.
  { north: 39.76965, south: 39.7619, west: -105.05325, east: -105.02475, rows: 8, columns: 13 },
  // W 32nd–W 38th Avenue, Federal Boulevard–Pecos Street.
  { north: 39.76965, south: 39.7619, west: -105.02515, east: -105.00615, rows: 8, columns: 13 },
  // W 38th–W 46th Avenue, Sheridan Boulevard–Federal Boulevard.
  { north: 39.78055, south: 39.76915, west: -105.05325, east: -105.02475, rows: 11, columns: 13 },
  // W 38th–W 46th Avenue, Federal Boulevard–Pecos Street.
  { north: 39.78055, south: 39.76915, west: -105.02515, east: -105.00615, rows: 11, columns: 13 }
];

const ADDRESSES = [
  "2500 Hooker St, Denver, CO", "2500 Irving St, Denver, CO", "2500 Julian St, Denver, CO",
  "2500 Knox Ct, Denver, CO", "2500 Lowell Blvd, Denver, CO", "2500 Meade St, Denver, CO",
  "2500 Perry St, Denver, CO", "2500 Raleigh St, Denver, CO", "2500 Stuart St, Denver, CO",
  "2500 Tennyson St, Denver, CO", "2100 Hooker St, Denver, CO", "2100 Irving St, Denver, CO",
  "2100 Julian St, Denver, CO", "2100 Lowell Blvd, Denver, CO", "2100 Perry St, Denver, CO",
  "2100 Raleigh St, Denver, CO", "2100 Stuart St, Denver, CO", "2100 Tennyson St, Denver, CO",
  "1800 Hooker St, Denver, CO", "1800 Irving St, Denver, CO", "1800 Julian St, Denver, CO",
  "1800 Lowell Blvd, Denver, CO", "1800 Perry St, Denver, CO", "1800 Raleigh St, Denver, CO",
  "1800 Stuart St, Denver, CO", "1800 Tennyson St, Denver, CO", "1450 Hooker St, Denver, CO",
  "1450 Irving St, Denver, CO", "1450 Julian St, Denver, CO", "1450 Lowell Blvd, Denver, CO",
  "1450 Perry St, Denver, CO", "1450 Raleigh St, Denver, CO", "1450 Stuart St, Denver, CO",
  "1450 Tennyson St, Denver, CO", "1450 Utica St, Denver, CO", "1450 Vrain St, Denver, CO",
  "1450 Winona Ct, Denver, CO", "1450 Wolff St, Denver, CO", "1450 Xavier St, Denver, CO",
  "1450 Yates St, Denver, CO", "1450 Zenobia St, Denver, CO", "1450 Sheridan Blvd, Denver, CO",
  "W Colfax Ave & Sheridan Blvd, Denver, CO", "W 17th Ave & Sheridan Blvd, Denver, CO",
  "W Colfax Ave & Utica St, Denver, CO", "W 17th Ave & Utica St, Denver, CO",
  "W 23rd Ave & Federal Blvd, Denver, CO", "W 26th Ave & Federal Blvd, Denver, CO",
  "W 20th Ave & Bryant St, Denver, CO", "W 23rd Ave & Bryant St, Denver, CO",
  "W 26th Ave & Bryant St, Denver, CO", "Mile High Stadium Cir, Denver, CO",
  "W 23rd Ave & Sheridan Blvd, Denver, CO", "W 26th Ave & Sheridan Blvd, Denver, CO",
  "W 29th Ave & Federal Blvd, Denver, CO", "W 32nd Ave & Federal Blvd, Denver, CO",
  "W 29th Ave & Sheridan Blvd, Denver, CO", "W 32nd Ave & Sheridan Blvd, Denver, CO",
  "W 35th Ave & Federal Blvd, Denver, CO", "W 38th Ave & Federal Blvd, Denver, CO",
  "W 35th Ave & Sheridan Blvd, Denver, CO", "W 38th Ave & Sheridan Blvd, Denver, CO",
  "W 41st Ave & Federal Blvd, Denver, CO", "W 44th Ave & Federal Blvd, Denver, CO",
  "W 46th Ave & Federal Blvd, Denver, CO", "W 41st Ave & Sheridan Blvd, Denver, CO",
  "W 44th Ave & Sheridan Blvd, Denver, CO", "W 46th Ave & Sheridan Blvd, Denver, CO",
  "W 32nd Ave & Pecos St, Denver, CO", "W 35th Ave & Pecos St, Denver, CO",
  "W 38th Ave & Pecos St, Denver, CO", "W 41st Ave & Pecos St, Denver, CO",
  "W 44th Ave & Pecos St, Denver, CO", "W 46th Ave & Pecos St, Denver, CO",
  "2500 Federal Blvd, Denver, CO", "2500 Sheridan Blvd, Denver, CO",
  "2800 Federal Blvd, Denver, CO", "2800 Sheridan Blvd, Denver, CO",
  "3100 Federal Blvd, Denver, CO", "3100 Sheridan Blvd, Denver, CO",
  "3400 Federal Blvd, Denver, CO", "3400 Sheridan Blvd, Denver, CO",
  "3700 Federal Blvd, Denver, CO", "3700 Sheridan Blvd, Denver, CO",
  "4000 Federal Blvd, Denver, CO", "4000 Sheridan Blvd, Denver, CO",
  "4300 Federal Blvd, Denver, CO", "4300 Sheridan Blvd, Denver, CO",
  "4500 Federal Blvd, Denver, CO", "4500 Sheridan Blvd, Denver, CO"
];

function sampleRegion(region) {
  const points = new Map();
  const latStep = (region.north - region.south) / (region.rows - 1);
  const lonStep = (region.east - region.west) / (region.columns - 1);
  const add = (lat, lon) => {
    const latitude = Number(lat.toFixed(6));
    const longitude = Number(lon.toFixed(6));
    points.set(`${latitude},${longitude}`, { latitude, longitude });
  };

  for (let row = 0; row < region.rows; row += 1) {
    for (let column = 0; column < region.columns; column += 1) {
      add(region.north - row * latStep, region.west + column * lonStep);
    }
  }
  for (let row = 0; row < region.rows - 1; row += 1) {
    for (let column = 0; column < region.columns - 1; column += 1) {
      add(region.north - (row + 0.5) * latStep, region.west + (column + 0.5) * lonStep);
    }
  }
  for (let row = 0; row < region.rows - 1; row += 1) {
    for (let column = 0; column < region.columns; column += 1) {
      add(region.north - (row + 0.5) * latStep, region.west + column * lonStep);
    }
  }
  for (let row = 0; row < region.rows; row += 1) {
    for (let column = 0; column < region.columns - 1; column += 1) {
      add(region.north - row * latStep, region.west + (column + 0.5) * lonStep);
    }
  }

  return Array.from(points.values());
}

async function runPool(urls) {
  const results = new Array(urls.length).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        const response = await fetch(urls[index]);
        if (response.ok) results[index] = await response.json();
      } catch {
        results[index] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

function addByronParkFrontageCoverage(routeMap) {
  const coverageId = "coverage-w-byron-vrain-winona";
  if (routeMap.has(coverageId)) return;

  const adjacentByronRoute = routeMap.get(5508) || routeMap.get(29145);
  if (!adjacentByronRoute) return;

  const path = [
    [39.7530522923091, -105.046292737183],
    [39.753046, -105.04678],
    [39.7530395949207, -105.047272668012]
  ];
  routeMap.set(coverageId, {
    ...adjacentByronRoute,
    id: coverageId,
    streetName: "W BYRON PL / DENVER PARK RD",
    from: "N VRAIN ST",
    to: "N WINONA CT",
    leftSweepingRule: "South side: The 3rd Thursday of the month. Matched to adjacent official Denver W Byron Pl routes.",
    rightSweepingRule: "North side: The 3rd Friday of the month. Matched to adjacent official Denver W Byron Pl routes.",
    isPosted: false,
    map: {
      staticMapUrl: "",
      center: path[1],
      path
    },
    sourceNote: "Denver's lookup returns no route for the park frontage; schedule matched to adjacent official W Byron Pl routes 5508 and 29145."
  });
}

function addWest46ParkFrontageCoverage(routeMap) {
  const coverageId = "coverage-w-46th-xavier-yates";
  if (routeMap.has(coverageId)) return;

  const adjacentWest46Route = routeMap.get(28251) || routeMap.get(28170);
  if (!adjacentWest46Route) return;

  const path = [
    [39.7802293122093, -105.049758431725],
    [39.780221, -105.05034],
    [39.7802121338296, -105.050921113208]
  ];
  routeMap.set(coverageId, {
    ...adjacentWest46Route,
    id: coverageId,
    streetName: "W 46TH AVE / DENVER PARK RD",
    from: "N XAVIER ST",
    to: "N YATES ST",
    leftSweepingRule: "South side: The 4th Friday of the month. Matched to adjacent official Denver W 46th Ave routes.",
    rightSweepingRule: "North side: The 4th Thursday of the month. Matched to adjacent official Denver W 46th Ave routes.",
    isPosted: false,
    map: {
      staticMapUrl: "",
      center: path[1],
      path
    },
    sourceNote: "Denver's lookup returns no route for the park frontage; schedule matched to adjacent official W 46th Ave routes 28251 and 28170."
  });
}

async function main() {
  const pointMap = new Map();
  REGIONS.forEach((region) => {
    sampleRegion(region).forEach((point) => pointMap.set(`${point.latitude},${point.longitude}`, point));
  });
  REQUIRED_ROUTE_ANCHORS.forEach((point) => pointMap.set(`${point.latitude},${point.longitude}`, point));

  const coordinateUrls = Array.from(pointMap.values()).map(({ latitude, longitude }) =>
    `${APP_ORIGIN}/api/denver/sweeping?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`
  );
  const addressUrls = ADDRESSES.map(
    (address) => `${APP_ORIGIN}/api/denver/sweeping?address=${encodeURIComponent(address)}`
  );
  const summaries = await runPool([...coordinateUrls, ...addressUrls]);
  const routeMap = new Map();

  summaries.filter(Boolean).forEach((summary) => {
    (Array.isArray(summary.routes) ? summary.routes : []).forEach((route) => {
      if (route?.id != null && Array.isArray(route.map?.path) && route.map.path.length >= 2) {
        routeMap.set(route.id, route);
      }
    });
  });
  addByronParkFrontageCoverage(routeMap);
  addWest46ParkFrontageCoverage(routeMap);

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    areaLabel: "West Denver expanded: Federal–Bryant at 20th–26th; Sheridan–Federal at 23rd–46th; Federal–Pecos at 26th–46th",
    routeCount: routeMap.size,
    routes: Array.from(routeMap.values())
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.writeFile(SCRIPT_OUTPUT_PATH, `window.DENVER_WEST_ROUTE_INVENTORY = ${JSON.stringify(payload)};\n`, "utf8");
  console.log(`Saved ${payload.routeCount} Denver routes to ${OUTPUT_PATH} and ${SCRIPT_OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
