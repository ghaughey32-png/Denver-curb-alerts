const fs = require("fs/promises");
const path = require("path");
const { auditInventory } = require("./lib/inventory-auditor.js");

const APP_ORIGIN = process.env.APP_ORIGIN || "http://127.0.0.1:3000";
const OUTPUT_PATH = path.join(__dirname, "..", "public", "denver-west-routes.json");
const SCRIPT_OUTPUT_PATH = path.join(__dirname, "..", "public", "denver-west-routes.js");
const EXPECTED_BLOCKS_PATH = path.join(__dirname, "..", "data", "inventory-expected-blocks.json");
const COVERAGE_REPORT_PATH = path.join(__dirname, "..", "data", "inventory-coverage-report.json");
const CONCURRENCY = 8;
const REQUIRED_ROUTE_ANCHORS = [
  // RiNo: Blake Street–Arapahoe Street, 27th–33rd Streets. These diagonal
  // intersection anchors make sure every short block reaches Denver's lookup.
  { latitude: 39.7585, longitude: -104.9865 },
  { latitude: 39.7605, longitude: -104.9835 },
  { latitude: 39.7625, longitude: -104.9805 },
  { latitude: 39.7645, longitude: -104.9775 },
  { latitude: 39.7665, longitude: -104.9745 },
  { latitude: 39.7565, longitude: -104.9805 },
  { latitude: 39.7585, longitude: -104.9775 },
  { latitude: 39.7605, longitude: -104.9745 },
  { latitude: 39.7625, longitude: -104.9715 },
  // Larimer Street, Broadway–27th. Check each previously omitted block.
  { latitude: 39.757314, longitude: -104.986954 },
  { latitude: 39.758088, longitude: -104.985943 },
  { latitude: 39.759029, longitude: -104.984734 },
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
  // RiNo street grid: Blake Street–Arapahoe Street, 27th–33rd Streets.
  // Dense sampling is intentional because the downtown grid runs diagonally.
  { north: 39.768, south: 39.7545, west: -104.989, east: -104.968, rows: 12, columns: 12 },
  // W 6th Avenue freeway–W 12th Avenue, Sheridan Boulevard–Federal Boulevard.
  { north: 39.73665, south: 39.72475, west: -105.05325, east: -105.02475, rows: 13, columns: 14 },
  // W 6th Avenue freeway–W 12th Avenue, Federal Boulevard–I-25.
  { north: 39.73665, south: 39.72475, west: -105.02515, east: -105.00525, rows: 13, columns: 12 },
  // W 13th Avenue–W Colfax Avenue, Sheridan Boulevard–Julian Street.
  // This block-scale grid powers map-first curb selection in West Colfax.
  { north: 39.74055, south: 39.73655, west: -105.05325, east: -105.0313, rows: 6, columns: 14 },
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
  { north: 39.78055, south: 39.76915, west: -105.02515, east: -105.00615, rows: 11, columns: 13 },
  // W 33rd–W 46th Avenue, Osage Street–Inca Street.
  // This tighter grid checks each short block in the I-25/Globeville corridor.
  { north: 39.78055, south: 39.763, west: -105.00615, east: -104.99715, rows: 17, columns: 11 },
  // W 47th Avenue–W 48th Avenue South Drive, Sheridan Boulevard–Quivas Street.
  { north: 39.7862, south: 39.7802, west: -105.05325, east: -105.00615, rows: 7, columns: 21 },
  // W 50th–W 52nd Avenue, Tennyson Street–Lowell Boulevard.
  // Sample at sub-block spacing so the short Berkeley/Regis grid is included.
  { north: 39.79125, south: 39.78705, west: -105.04465, east: -105.0342, rows: 6, columns: 10 },
  // W 50th–W 52nd Avenue, Federal Boulevard–Pecos Street.
  { north: 39.79125, south: 39.78705, west: -105.02515, east: -105.00615, rows: 6, columns: 14 }
];

const ADDRESSES = [
  "27th St & Blake St, Denver, CO", "27th St & Larimer St, Denver, CO",
  "27th St & Lawrence St, Denver, CO", "27th St & Arapahoe St, Denver, CO",
  "29th St & Blake St, Denver, CO", "29th St & Larimer St, Denver, CO",
  "29th St & Lawrence St, Denver, CO", "29th St & Arapahoe St, Denver, CO",
  "31st St & Blake St, Denver, CO", "31st St & Larimer St, Denver, CO",
  "31st St & Lawrence St, Denver, CO", "31st St & Arapahoe St, Denver, CO",
  "33rd St & Blake St, Denver, CO", "33rd St & Larimer St, Denver, CO",
  "33rd St & Lawrence St, Denver, CO", "33rd St & Arapahoe St, Denver, CO",
  "W 6th Ave & Sheridan Blvd, Denver, CO", "W 6th Ave & Federal Blvd, Denver, CO",
  "W 6th Ave & Zuni St, Denver, CO", "W 6th Ave & Pecos St, Denver, CO",
  "W 8th Ave & Sheridan Blvd, Denver, CO", "W 8th Ave & Federal Blvd, Denver, CO",
  "W 8th Ave & Zuni St, Denver, CO", "W 8th Ave & Pecos St, Denver, CO",
  "W 10th Ave & Sheridan Blvd, Denver, CO", "W 10th Ave & Federal Blvd, Denver, CO",
  "W 10th Ave & Zuni St, Denver, CO", "W 10th Ave & Pecos St, Denver, CO",
  "W 11th Ave & Sheridan Blvd, Denver, CO", "W 11th Ave & Federal Blvd, Denver, CO",
  "W 11th Ave & Zuni St, Denver, CO", "W 11th Ave & Pecos St, Denver, CO",
  "W 12th Ave & Sheridan Blvd, Denver, CO", "W 12th Ave & Federal Blvd, Denver, CO",
  "W 12th Ave & Zuni St, Denver, CO", "W 12th Ave & Pecos St, Denver, CO",
  "1350 Julian St, Denver, CO", "1350 King St, Denver, CO", "1350 Knox Ct, Denver, CO",
  "1350 Lowell Blvd, Denver, CO", "1350 Meade St, Denver, CO", "1350 Newton St, Denver, CO",
  "1350 Osceola St, Denver, CO", "1350 Perry St, Denver, CO", "1350 Quitman St, Denver, CO",
  "1350 Raleigh St, Denver, CO", "1350 Stuart St, Denver, CO", "1350 Tennyson St, Denver, CO",
  "1350 Utica St, Denver, CO", "1350 Vrain St, Denver, CO", "1350 Winona Ct, Denver, CO",
  "1350 Wolff St, Denver, CO", "1350 Xavier St, Denver, CO", "1350 Yates St, Denver, CO",
  "1350 Zenobia St, Denver, CO", "1350 Sheridan Blvd, Denver, CO",
  "W 13th Ave & Julian St, Denver, CO", "W 13th Ave & Lowell Blvd, Denver, CO",
  "W 13th Ave & Perry St, Denver, CO", "W 13th Ave & Tennyson St, Denver, CO",
  "W 13th Ave & Sheridan Blvd, Denver, CO",
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
  "W 33rd Ave & Osage St, Denver, CO", "W 35th Ave & Osage St, Denver, CO",
  "W 38th Ave & Osage St, Denver, CO", "W 41st Ave & Osage St, Denver, CO",
  "W 44th Ave & Osage St, Denver, CO", "W 46th Ave & Osage St, Denver, CO",
  "W 33rd Ave & Inca St, Denver, CO", "W 35th Ave & Inca St, Denver, CO",
  "W 38th Ave & Inca St, Denver, CO", "W 41st Ave & Inca St, Denver, CO",
  "W 44th Ave & Inca St, Denver, CO", "W 46th Ave & Inca St, Denver, CO",
  "W 47th Ave & Sheridan Blvd, Denver, CO", "W 48th Ave South Dr & Sheridan Blvd, Denver, CO",
  "W 47th Ave & Lowell Blvd, Denver, CO", "W 48th Ave South Dr & Lowell Blvd, Denver, CO",
  "W 47th Ave & Tennyson St, Denver, CO", "W 48th Ave South Dr & Tennyson St, Denver, CO",
  "W 47th Ave & Federal Blvd, Denver, CO", "W 48th Ave South Dr & Federal Blvd, Denver, CO",
  "W 47th Ave & Zuni St, Denver, CO", "W 48th Ave South Dr & Zuni St, Denver, CO",
  "W 47th Ave & Quivas St, Denver, CO", "W 48th Ave South Dr & Quivas St, Denver, CO",
  "W 50th Ave & Tennyson St, Denver, CO", "W 51st Ave & Tennyson St, Denver, CO",
  "W 52nd Ave & Tennyson St, Denver, CO", "W 50th Ave & Stuart St, Denver, CO",
  "W 51st Ave & Stuart St, Denver, CO", "W 52nd Ave & Stuart St, Denver, CO",
  "W 50th Ave & Raleigh St, Denver, CO", "W 51st Ave & Raleigh St, Denver, CO",
  "W 52nd Ave & Raleigh St, Denver, CO", "W 50th Ave & Perry St, Denver, CO",
  "W 51st Ave & Perry St, Denver, CO", "W 52nd Ave & Perry St, Denver, CO",
  "W 50th Ave & Lowell Blvd, Denver, CO", "W 51st Ave & Lowell Blvd, Denver, CO",
  "W 52nd Ave & Lowell Blvd, Denver, CO",
  "W 50th Ave & Federal Blvd, Denver, CO", "W 51st Ave & Federal Blvd, Denver, CO",
  "W 52nd Ave & Federal Blvd, Denver, CO", "W 50th Ave & Eliot St, Denver, CO",
  "W 51st Ave & Eliot St, Denver, CO", "W 52nd Ave & Eliot St, Denver, CO",
  "W 50th Ave & Decatur St, Denver, CO", "W 51st Ave & Decatur St, Denver, CO",
  "W 52nd Ave & Decatur St, Denver, CO", "W 50th Ave & Zuni St, Denver, CO",
  "W 51st Ave & Zuni St, Denver, CO", "W 52nd Ave & Zuni St, Denver, CO",
  "W 50th Ave & Tejon St, Denver, CO", "W 51st Ave & Tejon St, Denver, CO",
  "W 52nd Ave & Tejon St, Denver, CO", "W 50th Ave & Pecos St, Denver, CO",
  "W 51st Ave & Pecos St, Denver, CO", "W 52nd Ave & Pecos St, Denver, CO",
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

function mergeRoute(routeMap, incoming) {
  const existing = routeMap.get(incoming.id);
  if (!existing) {
    routeMap.set(incoming.id, incoming);
    return;
  }

  // Denver can return a clipped path for the same route depending on which
  // address found it. Preserve the richest response rather than allowing the
  // last lookup to silently shorten an already-discovered street segment.
  const existingPath = Array.isArray(existing.map?.path) ? existing.map.path : [];
  const incomingPath = Array.isArray(incoming.map?.path) ? incoming.map.path : [];
  const geometrySource = incomingPath.length > existingPath.length ? incoming : existing;
  routeMap.set(incoming.id, {
    ...existing,
    ...incoming,
    leftSweepingRule: incoming.leftSweepingRule || existing.leftSweepingRule,
    rightSweepingRule: incoming.rightSweepingRule || existing.rightSweepingRule,
    schedules: incoming.schedules?.length ? incoming.schedules : existing.schedules,
    map: geometrySource.map
  });
}

function applyLocalStreetNameOverrides(routeMap) {
  const lakeshoreRoute = routeMap.get(28451);
  if (!lakeshoreRoute || !Array.isArray(lakeshoreRoute.map?.path) || lakeshoreRoute.map.path.length < 4) return;
  const [quitman, bend, alley, raleigh] = lakeshoreRoute.map.path;
  routeMap.delete(28451);
  routeMap.set("28451-w-20th", {
    ...lakeshoreRoute,
    id: "28451-w-20th",
    officialRouteId: 28451,
    streetName: "W 20TH AVE",
    from: "N QUITMAN ST",
    to: "ALLEY BETWEEN N QUITMAN ST AND N RALEIGH ST",
    map: { ...lakeshoreRoute.map, staticMapUrl: "", center: bend, path: [quitman, bend, alley] },
    sourceNote: "Local display name follows the current roadway name through the alley; Denver route 28451 supplies the weekly sweeping rule."
  });
  routeMap.set("28451-w-lakeshore", {
    ...lakeshoreRoute,
    id: "28451-w-lakeshore",
    officialRouteId: 28451,
    from: "ALLEY BETWEEN N QUITMAN ST AND N RALEIGH ST",
    to: "N RALEIGH ST",
    map: { ...lakeshoreRoute.map, staticMapUrl: "", center: alley, path: [alley, raleigh] },
    sourceNote: "Local display-name split at the alley; Denver route 28451 supplies the weekly sweeping rule."
  });
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

function addWest48FederalEliotCoverage(routeMap) {
  const coverageId = "coverage-w-48th-south-dr-west-end-eliot";
  if (routeMap.has(coverageId)) return;

  const adjacentWest48Route = routeMap.get(22688);
  if (!adjacentWest48Route) return;

  const path = [
    [39.783794, -105.02458],
    [39.783795, -105.02426],
    [39.7837967821555, -105.023951191204]
  ];
  routeMap.set(coverageId, {
    ...adjacentWest48Route,
    id: coverageId,
    streetName: "W 48TH SOUTH DR",
    from: "WEST END",
    to: "N ELIOT ST/NMCHG",
    isPosted: false,
    map: {
      staticMapUrl: "",
      center: path[1],
      path
    },
    sourceNote: "Denver's lookup omits the frontage-road west end; schedule matched to adjacent official W 48th South Dr route 22688."
  });
}

function addWest11FederalDecaturCoverage(routeMap) {
  const coverageId = "coverage-w-11th-federal-decatur";
  if (routeMap.has(coverageId)) return;

  const westRoute = routeMap.get(5187);
  const eastRoute = routeMap.get(18240);
  const adjacentWest11Route = westRoute || eastRoute;
  if (!adjacentWest11Route) return;

  const path = [
    [39.7338791010489, -105.023379744091],
    [39.7338784, -105.02256],
    [39.7338776268528, -105.021747711029]
  ];
  routeMap.set(coverageId, {
    ...adjacentWest11Route,
    id: coverageId,
    streetName: "W 11TH AVE",
    from: "WEST GATEWAY NORTH ENTRANCE",
    to: "N DECATUR ST",
    isPosted: false,
    map: {
      staticMapUrl: "",
      center: path[1],
      path
    },
    sourceNote: "Denver omits geometry for the continuous Gateway North block; schedule matched to adjacent official W 11th Ave routes 5187 and 18240."
  });
}

function ensureWest10FederalDecaturCoverage(routeMap) {
  const coverageId = "coverage-w-10th-federal-east-end";
  if (routeMap.has(coverageId)) return;

  const officialRoute = routeMap.get(17891);
  if (!officialRoute) return;

  routeMap.set(coverageId, {
    ...officialRoute,
    id: coverageId,
    map: {
      ...officialRoute.map,
      staticMapUrl: "",
      center: [39.7329895, -105.020162726271],
      path: [
        [39.7329892955418, -105.025162700528],
        [39.7329895172622, -105.02174399127],
        [39.7329895, -105.020162726271],
        [39.7329895, -105.019308487678],
        [39.7329894, -105.01851384253],
        [39.7329893, -105.017428487905]
      ]
    },
    from: "N FEDERAL BLVD/TRAFFIC SIGNAL",
    to: "EAST END",
    sourceNote: "Denver's east-of-Decatur records reuse W 11th latitude geometry; their official junction longitudes and schedule are aligned to the continuous W 10th roadway."
  });
}

function ensureRinoOfficialRouteCoverage(routeMap) {
  const addConfirmedRoute = ({ id, adjacentId, streetName, from, to, path }) => {
    if (routeMap.has(id)) return;
    const adjacent = routeMap.get(adjacentId);
    if (!adjacent) return;
    routeMap.set(id, {
      ...adjacent,
      id,
      streetName,
      from,
      to,
      map: { staticMapUrl: "", center: path[Math.floor(path.length / 2)], path },
      sourceNote: "Denver's exact-address lookup confirms this scheduled route; geometry joins its official Larimer and Blake endpoints."
    });
  };

  addConfirmedRoute({
    id: 23947,
    adjacentId: 23948,
    streetName: "26TH ST",
    from: "LARIMER ST",
    to: "BLAKE ST",
    path: [[39.7585552407673, -104.98533900067], [39.758900704267, -104.985788196374], [39.7592327014274, -104.986218819592]]
  });
  addConfirmedRoute({
    id: 24031,
    adjacentId: 24033,
    streetName: "28TH ST",
    from: "LARIMER ST",
    to: "BLAKE ST",
    path: [[39.7604265567974, -104.982931405626], [39.760762, -104.983369], [39.7610978334174, -104.983805935064]]
  });
  [
    [24034, 24037, "29TH ST", [[39.7613543146548, -104.981730283549], [39.761694, -104.982164], [39.7620331112184, -104.982594973694]]],
    [22697, 22700, "30TH ST", [[39.7622816549047, -104.980514904814], [39.7626191924194, -104.98095259692], [39.7629605231865, -104.981394709113]]],
    [22708, 22707, "32ND ST", [[39.7641672632269, -104.978102492644], [39.7644896411491, -104.978525182445], [39.7648272054731, -104.978967327292]]],
    [22784, 22714, "33RD ST", [[39.7650922531457, -104.976907494732], [39.7654239322604, -104.97733722494], [39.7657652802023, -104.977780228784]]]
  ].forEach(([id, adjacentId, streetName, path]) => addConfirmedRoute({ id, adjacentId, streetName, from: "LARIMER ST", to: "BLAKE ST", path }));

  addConfirmedRoute({
    id: 12099, adjacentId: 22701, streetName: "31ST ST", from: "LARIMER ST", to: "END",
    path: [[39.7632168516104, -104.97929409996], [39.7635675526233, -104.979759263696], [39.7635741115873, -104.979767941308]]
  });
  if (!routeMap.has("unavailable-31st-end-blake")) {
    const adjacent = routeMap.get(22701);
    const path = [[39.7635741115873, -104.979767941308], [39.7638844223947, -104.980178436626]];
    routeMap.set("unavailable-31st-end-blake", {
      ...adjacent, id: "unavailable-31st-end-blake", streetName: "31ST ST", from: "END", to: "BLAKE ST",
      sweepType: "Unavailable", leftSweepingRule: "Denver route data unavailable — check posted signs.",
      rightSweepingRule: "Denver route data unavailable — check posted signs.", schedules: [], dataUnavailable: true,
      map: { staticMapUrl: "", center: path[0], path }
    });
  }

  const route = routeMap.get(24018);
  if (!route) return;

  // Denver's address result identifies route 24018 as 27th St from Larimer
  // through Blake to Walnut. Some coordinate lookups return only Blake–Walnut.
  const path = [
    [39.7595021964107, -104.984128022484],
    [39.7601570134517, -104.985007116449],
    [39.7605007632197, -104.985456328745],
    [39.7608300127708, -104.985886980374]
  ];
  routeMap.set(24018, {
    ...route,
    from: "LARIMER ST",
    to: "WALNUT ST",
    map: { ...route.map, center: path[1], path }
  });
}

async function main() {
  const expectedBlockManifest = JSON.parse(await fs.readFile(EXPECTED_BLOCKS_PATH, "utf8"));
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
        mergeRoute(routeMap, route);
      }
    });
  });
  addByronParkFrontageCoverage(routeMap);
  addWest46ParkFrontageCoverage(routeMap);
  addWest48FederalEliotCoverage(routeMap);
  addWest11FederalDecaturCoverage(routeMap);
  ensureWest10FederalDecaturCoverage(routeMap);
  ensureRinoOfficialRouteCoverage(routeMap);
  applyLocalStreetNameOverrides(routeMap);

  const audit = auditInventory({ routes: routeMap, blocks: expectedBlockManifest.blocks });
  audit.generatedRoutes.forEach((route) => routeMap.set(route.id, route));
  const coverageReport = {
    ...audit.report,
    generatedAt: new Date().toISOString(),
    expectedBlockManifestVersion: expectedBlockManifest.version
  };

  if (audit.unexplainedGaps.length) {
    const ids = audit.unexplainedGaps.map((block) => block.id || "unnamed").join(", ");
    throw new Error(`Inventory build failed: unexplained public-road gaps: ${ids}`);
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    areaLabel: "Denver expanded: West Denver inventory plus RiNo from Blake–Arapahoe and 27th–33rd Streets",
    routeCount: routeMap.size,
    routes: Array.from(routeMap.values())
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.writeFile(SCRIPT_OUTPUT_PATH, `window.DENVER_WEST_ROUTE_INVENTORY = ${JSON.stringify(payload)};\n`, "utf8");
  await fs.writeFile(COVERAGE_REPORT_PATH, `${JSON.stringify(coverageReport, null, 2)}\n`, "utf8");
  console.log(`Saved ${payload.routeCount} Denver routes; coverage: ${coverageReport.counts.scheduled} scheduled, ${coverageReport.counts.unavailable} unavailable, ${coverageReport.counts.excluded} excluded, ${coverageReport.counts["unexplained-gap"]} unexplained gaps.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
