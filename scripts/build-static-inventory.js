const fs = require("fs/promises");
const path = require("path");
const { auditInventory } = require("./lib/inventory-auditor.js");
const { addConfirmedValverdeCoverage } = require("./lib/confirmed-valverde-coverage.js");
const { applyConfirmedVrainCoverage } = require("./lib/confirmed-vrain-coverage.js");
const { applyConfirmedRegisAreaCoverage } = require("./lib/confirmed-regis-area-coverage.js");
const { applyConfirmedPoloClubCoverage } = require("./lib/confirmed-polo-club-coverage.js");

const APP_ORIGIN = process.env.APP_ORIGIN || "http://127.0.0.1:3000";
const OUTPUT_PATH = path.join(__dirname, "..", "public", "denver-west-routes.json");
const SCRIPT_OUTPUT_PATH = path.join(__dirname, "..", "public", "denver-west-routes.js");
const EXPECTED_BLOCKS_PATH = path.join(__dirname, "..", "data", "inventory-expected-blocks.json");
const COVERAGE_REPORT_PATH = path.join(__dirname, "..", "data", "inventory-coverage-report.json");
const CONCURRENCY = 8;
const REQUIRED_ROUTE_ANCHORS = [
  // S Irving Street Parkway inside the S Hooker/S Julian circle. Denver
  // models the divided roadway as two parallel routes; keep an anchor on
  // each carriageway so both sets of curb lines survive inventory rebuilds.
  { latitude: 39.6802, longitude: -105.02988 },
  { latitude: 39.6802, longitude: -105.02972 },
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
  // W 1st Avenue–W 5th Avenue, Sheridan Boulevard–Federal Boulevard.
  // Sample at roughly half-block spacing around the Weir Gulch crossings and
  // the short street sections beside the W 6th Avenue interchange.
  { north: 39.72415, south: 39.71805, west: -105.05325, east: -105.02475, rows: 9, columns: 18 },
  // W 6th Avenue freeway–W 12th Avenue, Sheridan Boulevard–Federal Boulevard.
  { north: 39.73665, south: 39.72475, west: -105.05325, east: -105.02475, rows: 13, columns: 14 },
  // W 6th Avenue freeway–W 12th Avenue, Federal Boulevard–I-25.
  { north: 39.73665, south: 39.72475, west: -105.02515, east: -105.00525, rows: 13, columns: 12 },
  // W 5th Avenue–W Alameda Avenue (CO 26), Federal Boulevard–I-25.
  { north: 39.7244, south: 39.7104, west: -105.0254, east: -105.0002, rows: 15, columns: 16 },
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
  "W 1st Ave & Sheridan Blvd, Denver, CO", "W 1st Ave & Federal Blvd, Denver, CO",
  "W 2nd Ave & Sheridan Blvd, Denver, CO", "W 2nd Ave & Federal Blvd, Denver, CO",
  "W 3rd Ave & Sheridan Blvd, Denver, CO", "W 3rd Ave & Federal Blvd, Denver, CO",
  "W 4th Ave & Sheridan Blvd, Denver, CO", "W 4th Ave & Federal Blvd, Denver, CO",
  "W 5th Ave & Sheridan Blvd, Denver, CO", "W 5th Ave & Federal Blvd, Denver, CO",
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
  "W 5th Ave & Federal Blvd, Denver, CO", "W 5th Ave & Zuni St, Denver, CO",
  "W 5th Ave & Pecos St, Denver, CO", "W 5th Ave & I-25, Denver, CO",
  "W 1st Ave & Federal Blvd, Denver, CO", "W 1st Ave & Zuni St, Denver, CO",
  "W 1st Ave & Pecos St, Denver, CO", "W 1st Ave & I-25, Denver, CO",
  "W Alameda Ave & Federal Blvd, Denver, CO", "W Alameda Ave & Zuni St, Denver, CO",
  "W Alameda Ave & Pecos St, Denver, CO", "W Alameda Ave & I-25, Denver, CO",
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

function addConfirmedSouthJulianWayCoverage(routeMap) {
  const officialRoute = routeMap.get(19406);
  if (!officialRoute) return;

  const fallbackId = "unavailable-florida-evans-sheridan-federal-osm-16989248-176076646-176104112-0";
  routeMap.delete(fallbackId);
  const path = [
    [39.6876451, -105.031587],
    [39.685941, -105.031587],
    [39.6854918, -105.0316213],
    [39.6853267, -105.0317243]
  ];
  routeMap.set("confirmed-s-julian-way-iowa-mexico", {
    ...officialRoute,
    id: "confirmed-s-julian-way-iowa-mexico",
    officialRouteId: 19406,
    from: "W IOWA AVE",
    to: "W MEXICO AVE/NMCHG",
    map: { ...officialRoute.map, staticMapUrl: "", center: path[1], path },
    sourceNote: "Schedule confirmed by Denver route 19406; public-road geometry completes the short curve to the W Mexico Ave name-change endpoint."
  });
}

function addConfirmedWestWesleyPlatteJasonCoverage(routeMap) {
  const path = [
    [39.6730269895347, -104.998225795144],
    [39.6730318, -104.99882],
    [39.6730363707072, -104.999451214552]
  ];
  routeMap.set("confirmed-w-wesley-platte-jason", {
    id: "confirmed-w-wesley-platte-jason",
    streetId: 974,
    streetName: "W WESLEY AVE",
    from: "S PLATTE RIVER DR",
    to: "S JASON ST",
    sweepType: "Weekly",
    leftSweepDirection: "South",
    rightSweepDirection: "North",
    leftSweepingRule: "South side: The 1st week of the month.",
    rightSweepingRule: "North side: The 1st week of the month.",
    schedules: [],
    isPosted: false,
    map: { staticMapUrl: "", center: path[1], path },
    sourceNote: "Schedule and endpoints confirmed from Denver Street Sweeping Schedules and Alerts screenshot, August 16, 2026; sweeping runs April through November and vehicle relocation is not required during sweeping week."
  });
}

function addConfirmedSouthPlatteIliffWesleyCoverage(routeMap) {
  const path = [
    [39.6748329, -104.998191],
    [39.67393, -104.998208],
    [39.6730269895347, -104.998225795144]
  ];
  routeMap.set("confirmed-s-platte-iliff-wesley", {
    id: "confirmed-s-platte-iliff-wesley",
    streetId: 575,
    streetName: "S PLATTE RIVER DR",
    from: "W ILIFF AVE",
    to: "W WESLEY AVE",
    sweepType: "Weekly",
    leftSweepDirection: "East",
    rightSweepDirection: "West",
    leftSweepingRule: "East side: The 1st week of the month.",
    rightSweepingRule: "West side: The 1st week of the month.",
    schedules: [],
    isPosted: false,
    map: { staticMapUrl: "", center: path[1], path },
    sourceNote: "Schedule and endpoints confirmed from Denver Street Sweeping Schedules and Alerts screenshot, August 16, 2026; sweeping runs April through November and vehicle relocation is not required during sweeping week."
  });
}

function applySouthHookerWayWesleyCurveCoverage(routeMap, expectedBlocks) {
  const officialRoute = routeMap.get(8385);
  if (!officialRoute) return;

  // OSM calls this short curve W Wesley Ave, but it is the continuation of
  // S Hooker Way through the S Irving St junction. Denver route 8385 already
  // supplies both curb schedules, so do not publish a second pink route over
  // the same pavement.
  routeMap.delete("unavailable-evans-yale-sheridan-federal-osm-16989337-176111335-176092444-0");
  const curve = expectedBlocks.find((block) => block.id === "evans-yale-sheridan-federal-osm-16989337-176111335-176092444-0");
  if (curve) {
    curve.streetName = "South Hooker Way";
    curve.from = "W ILIFF AVE";
    curve.to = "S IRVING ST/W WESLEY AVE";
  }
}

function confirmSouthOsceolaWayYaleNewtonCoverage(routeMap) {
  const route = routeMap.get(3244);
  if (!route) return;

  routeMap.set(3244, {
    ...route,
    streetName: "S OSCEOLA WAY",
    from: "S OSCEOLA ST/W YALE AVE",
    to: "S NEWTON ST",
    sweepType: "Weekly",
    leftSweepDirection: "East",
    rightSweepDirection: "West",
    leftSweepingRule: "East side: The 2nd week of the month.",
    rightSweepingRule: "West side: The 2nd week of the month.",
    schedules: [],
    isPosted: false,
    dataUnavailable: false,
    sourceNote: "Schedule and endpoints confirmed from Denver Street Sweeping Schedules and Alerts screenshot, August 16, 2026; no vehicle relocation required during sweeping week."
  });
}

function extendSouthPecosCoverageNorthOfPacific(routeMap) {
  const route = routeMap.get(27084);
  if (!route) return;

  // Denver route 27084 supplies the same confirmed curb schedule through the
  // short Pecos continuation north of W Pacific Pl. Fold that continuation
  // into the official route instead of drawing a pink unavailable fallback.
  const northernAnchor = [39.679963, -105.0063528];
  // Unlike the other patches this one splices new points onto whatever
  // geometry it is given, so re-running it over an already-extended route
  // would duplicate them. Bail out when the extension is already present.
  const [firstLatitude, firstLongitude] = route.map.path[0] || [];
  if (firstLatitude === northernAnchor[0] && firstLongitude === northernAnchor[1]) return;

  const path = [
    northernAnchor,
    [39.6796724, -105.0063613],
    [39.6795819463647, -105.006414247991],
    ...route.map.path.slice(1)
  ];
  routeMap.set(27084, {
    ...route,
    from: "BGN",
    map: { ...route.map, staticMapUrl: "", center: path[2], path },
    sourceNote: `${route.sourceNote || "Denver route 27084."} Geometry extended through the public-road continuation north of W Pacific Pl.`
  });
}

function addConfirmedSouthPattonWyeCoverage(routeMap) {
  const officialRoute = routeMap.get(18232);
  if (!officialRoute) return;

  const fallbackId = "unavailable-bayaud-exposition-sheridan-federal-osm-37273289-176106473-434298297-0";
  routeMap.delete(fallbackId);
  const path = [
    [39.7039479, -105.0395334],
    [39.7038671, -105.0394017],
    [39.7037699, -105.0392786],
    [39.7036874, -105.0391923],
    [39.7035274, -105.0391371]
  ];
  routeMap.set("confirmed-s-patton-exposition-wye", {
    ...officialRoute,
    id: "confirmed-s-patton-exposition-wye",
    officialRouteId: 18232,
    streetName: "S PATTON CT",
    from: "W EXPOSITION AVE/S PERRY ST",
    to: "WYE",
    map: { ...officialRoute.map, staticMapUrl: "", center: path[2], path },
    sourceNote: "Denver route 18232 confirms the S Patton Ct name and schedule; public-road geometry completes the diagonal connector to its wye."
  });
}

function applySouthKnoxAlamedaInterchangeGeometry(routeMap) {
  const northApproach = routeMap.get(3297);
  const southApproach = routeMap.get(11719);
  if (!northApproach || !southApproach) return;

  const northPath = [
    [39.713378806876, -105.032459730268],
    [39.7116798, -105.0324893], [39.7116254, -105.0324911],
    [39.7115678, -105.032498], [39.7115324, -105.0325059],
    [39.7114878, -105.0325251], [39.7114409, -105.0325539],
    [39.711383, -105.0326054], [39.7113452, -105.0326419],
    [39.7113206, -105.0326718], [39.7112642, -105.0327527]
  ];
  const southPath = [
    [39.711142, -105.0326652], [39.7110646, -105.0325398],
    [39.7110509, -105.0325228], [39.7110321, -105.03251],
    [39.7110102, -105.0324967], [39.7109697, -105.032486],
    [39.710725, -105.0324807], [39.7105092, -105.0324766],
    [39.7103812, -105.0324732], [39.7103249, -105.0324727]
  ];
  routeMap.set(3297, { ...northApproach, map: { ...northApproach.map, staticMapUrl: "", center: northPath[5], path: northPath } });
  routeMap.set(11719, { ...southApproach, map: { ...southApproach.map, staticMapUrl: "", center: southPath[5], path: southPath } });
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
  const addUnavailableWalnutBlock = ({ id, from, to, path }) => {
    if (routeMap.has(id)) return;
    routeMap.set(id, {
      id,
      streetName: "WALNUT ST",
      from,
      to,
      sweepType: "Unavailable",
      leftSweepDirection: "Left",
      rightSweepDirection: "Right",
      leftSweepingRule: "Denver route data unavailable — check posted signs.",
      rightSweepingRule: "Denver route data unavailable — check posted signs.",
      schedules: [],
      isPosted: false,
      dataUnavailable: true,
      map: { staticMapUrl: "", center: path[Math.floor(path.length / 2)], path },
      sourceNote: "Denver's Street Sweeping Schedules and Alerts lookup confirms an April–November sweeping season for this block but provides no usable side or date schedule."
    });
  };

  const addUnavailableRinoBlock = ({ id, streetName, from, to, path }) => {
    if (routeMap.has(id)) return;
    routeMap.set(id, {
      id, streetName, from, to,
      sweepType: "Unavailable",
      leftSweepDirection: "Left",
      rightSweepDirection: "Right",
      leftSweepingRule: "Denver route data unavailable — check posted signs.",
      rightSweepingRule: "Denver route data unavailable — check posted signs.",
      schedules: [], isPosted: false, dataUnavailable: true,
      map: { staticMapUrl: "", center: path[Math.floor(path.length / 2)], path },
      sourceNote: "Pink verification coverage added for a visible RiNo map gap; check posted signs."
    });
  };

  addUnavailableWalnutBlock({
    id: "unavailable-walnut-27th-28th",
    from: "27TH ST",
    to: "28TH ST",
    path: [[39.7608300127708, -104.985886980374], [39.7609639, -104.9848465], [39.7610978334174, -104.983805935064]]
  });
  addUnavailableWalnutBlock({
    id: "unavailable-walnut-28th-29th",
    from: "28TH ST",
    to: "29TH ST",
    path: [[39.7610978334174, -104.983805935064], [39.7615655, -104.9832005], [39.7620331112184, -104.982594973694]]
  });
  addUnavailableWalnutBlock({
    id: "unavailable-walnut-29th-30th",
    from: "29TH ST",
    to: "30TH ST",
    path: [[39.7620331112184, -104.982594973694], [39.7624968, -104.9819948], [39.7629605231865, -104.981394709113]]
  });
  addUnavailableWalnutBlock({
    id: "unavailable-walnut-31st-32nd",
    from: "31ST ST",
    to: "32ND ST",
    path: [[39.7638844223947, -104.980178436626], [39.7643558, -104.9795729], [39.7648272054731, -104.978967327292]]
  });
  [
    ["unavailable-walnut-30th-31st", "30TH ST", "31ST ST", [[39.7629605231865, -104.981394709113], [39.7634225, -104.9807866], [39.7638844223947, -104.980178436626]]],
    ["unavailable-walnut-32nd-33rd", "32ND ST", "33RD ST", [[39.7648272054731, -104.978967327292], [39.7652962, -104.9783738], [39.7657652802023, -104.977780228784]]],
    ["unavailable-walnut-33rd-34th", "33RD ST", "34TH ST", [[39.7657652802023, -104.977780228784], [39.7662293, -104.9771743], [39.7666932784295, -104.976568273298]]],
    ["unavailable-walnut-34th-35th", "34TH ST", "35TH ST", [[39.7666932784295, -104.976568273298], [39.7671587, -104.9759658], [39.7676240441772, -104.9753633794]]]
  ].forEach(([id, from, to, path]) => addUnavailableRinoBlock({ id, streetName: "WALNUT ST", from, to, path }));

  [
    ["unavailable-larimer-33rd-34th", "33RD ST", "34TH ST", [[39.7650922531457, -104.976907494732], [39.7655592, -104.9763002], [39.7660261, -104.975693]]],
    ["unavailable-larimer-34th-35th", "34TH ST", "35TH ST", [[39.7660261, -104.975693], [39.7664901, -104.9750989], [39.7669541504805, -104.974504850619]]]
  ].forEach(([id, from, to, path]) => addUnavailableRinoBlock({ id, streetName: "LARIMER ST", from, to, path }));

  addUnavailableRinoBlock({
    id: "unavailable-35th-larimer-walnut", streetName: "35TH ST", from: "LARIMER ST", to: "WALNUT ST",
    path: [[39.7669541504805, -104.974504850619], [39.7672891, -104.9749341], [39.7676240441772, -104.9753633794]]
  });

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
  const markUnavailable = (id, from, to) => {
    const existing = routeMap.get(id);
    if (!existing) return;
    routeMap.set(id, {
      ...existing,
      from,
      to,
      sweepType: "Unavailable",
      leftSweepingRule: "Denver route data unavailable — check posted signs.",
      rightSweepingRule: "Denver route data unavailable — check posted signs.",
      schedules: [],
      isPosted: false,
      dataUnavailable: true,
      sourceNote: "Denver's Street Sweeping Schedules and Alerts lookup shows this road portion but provides no usable side or date schedule."
    });
  };
  addConfirmedRoute({
    id: 24031,
    adjacentId: 24033,
    streetName: "28TH ST",
    from: "LARIMER ST",
    to: "BLAKE ST",
    path: [[39.7604265567974, -104.982931405626], [39.760762, -104.983369], [39.7610978334174, -104.983805935064]]
  });
  markUnavailable(24031, "LARIMER ST", "WALNUT ST");
  markUnavailable(24033, "WALNUT ST", "BLAKE ST");
  addConfirmedRoute({
    id: "confirmed-34th-larimer-walnut",
    adjacentId: 22787,
    streetName: "34TH ST",
    from: "LARIMER ST",
    to: "WALNUT ST",
    path: [[39.7660261, -104.975693], [39.7663597, -104.9761306], [39.7666932784295, -104.976568273298]]
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

// The hand-curated coverage corrections applied to a freshly crawled route set,
// before the audit runs. These assume the routes came straight from Denver, so
// rebuild:offline deliberately does not replay them over an already-published
// payload -- see the header of scripts/rebuild-inventory-offline.js.
function applyCoveragePatches(routeMap, expectedBlocks) {
  addByronParkFrontageCoverage(routeMap);
  addWest46ParkFrontageCoverage(routeMap);
  addWest48FederalEliotCoverage(routeMap);
  addWest11FederalDecaturCoverage(routeMap);
  ensureWest10FederalDecaturCoverage(routeMap);
  ensureRinoOfficialRouteCoverage(routeMap);
  applyLocalStreetNameOverrides(routeMap);
  addConfirmedValverdeCoverage(routeMap);
  applyConfirmedVrainCoverage(routeMap);
  applyConfirmedRegisAreaCoverage(routeMap);
  applyConfirmedPoloClubCoverage(routeMap);
  addConfirmedSouthJulianWayCoverage(routeMap);
  addConfirmedWestWesleyPlatteJasonCoverage(routeMap);
  addConfirmedSouthPlatteIliffWesleyCoverage(routeMap);
  applySouthHookerWayWesleyCurveCoverage(routeMap, expectedBlocks);
  confirmSouthOsceolaWayYaleNewtonCoverage(routeMap);
  extendSouthPecosCoverageNorthOfPacific(routeMap);
  addConfirmedSouthPattonWyeCoverage(routeMap);
  applySouthKnoxAlamedaInterchangeGeometry(routeMap);
}

// Audits the patched routes, drops the fallbacks that would overlap confirmed
// coverage, and writes the three published artifacts. Throws instead of
// publishing when a mapped public block would render blank.
async function auditAndPublish(routeMap, expectedBlockManifest) {
  const audit = auditInventory({ routes: routeMap, blocks: expectedBlockManifest.blocks });
  audit.generatedRoutes.forEach((route) => routeMap.set(route.id, route));
  // The source map incorrectly contains a second South Lowell roadway east of
  // the real boulevard between W Evans Ave and W Warren Ave.
  routeMap.delete("unavailable-florida-evans-sheridan-federal-osm-16984766-176091629-176076121-0");
  // Route 3244 already supplies confirmed 2nd-week curb coverage from the
  // Yale intersection through the Osceola Way bend. Do not publish the
  // overlapping pink South Osceola Street fallback.
  routeMap.delete("unavailable-evans-yale-sheridan-federal-osm-16985383-11429256142-176095986-0");
  // Route 27084 now includes the short S Pecos continuation north of Pacific,
  // so the overlapping pink fallback must not survive the coverage audit.
  routeMap.delete("unavailable-florida-yale-federal-i25-osm-37290027-176110603-176106054-0");
  // Denver route 24360 supplies the posted E 26th Avenue Parkway schedule
  // from York Street to Josephine Street. The OSM expected block ends partway
  // through that official geometry, so the auditor cannot match it closely
  // enough and otherwise publishes a duplicate pink fallback over the route.
  routeMap.delete("unavailable-e17-e26-downing-york-osm-239249844-176088017-2823784462-0");
  const coverageReport = {
    ...audit.report,
    generatedAt: new Date().toISOString(),
    expectedBlockManifestVersion: expectedBlockManifest.version
  };

  if (audit.unexplainedGaps.length) {
    const ids = audit.unexplainedGaps.map((block) => block.id || "unnamed").join(", ");
    throw new Error(`Inventory build failed: unexplained public-road gaps: ${ids}`);
  }

  await writeInventoryArtifacts(routeMap, coverageReport);
}

// Writes the three published artifacts. The .json and the .js carry the same
// payload and are always written together, so keep them in one place.
async function writeInventoryArtifacts(routeMap, coverageReport) {
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

  applyCoveragePatches(routeMap, expectedBlockManifest.blocks);
  await auditAndPublish(routeMap, expectedBlockManifest);
}

module.exports = {
  applyCoveragePatches,
  auditAndPublish,
  writeInventoryArtifacts,
  EXPECTED_BLOCKS_PATH,
  OUTPUT_PATH
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
