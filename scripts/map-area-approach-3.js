const fs = require("fs/promises");
const path = require("path");
const { auditInventory, normalizeStreetName } = require("./lib/inventory-auditor.js");
const { slimRoutesForPublication } = require("./lib/publish-payload.js");

const ROOT = path.join(__dirname, "..");
const AREA_ID = process.argv[2];
const APP_ORIGIN = process.env.APP_ORIGIN || "https://denver-curb-alerts-2.onrender.com";
const CONCURRENCY = 6;

const manifestPath = path.join(ROOT, "data", "inventory-expected-blocks.json");
const inventoryPath = path.join(ROOT, "public", "denver-west-routes.json");
const cachePath = path.join(ROOT, "data", `mapping-cache-${AREA_ID}.json`);
const reportPath = path.join(ROOT, "data", `mapping-report-${AREA_ID}.json`);

function pointAt(pathPoints, ratio) {
  const distances = [];
  let total = 0;
  for (let index = 1; index < pathPoints.length; index += 1) {
    const a = pathPoints[index - 1]; const b = pathPoints[index];
    const distance = Math.hypot((b[0] - a[0]) * 111000, (b[1] - a[1]) * 85000);
    distances.push(distance); total += distance;
  }
  let target = total * ratio;
  for (let index = 0; index < distances.length; index += 1) {
    if (target <= distances[index]) {
      const local = distances[index] ? target / distances[index] : 0;
      return [
        pathPoints[index][0] + (pathPoints[index + 1][0] - pathPoints[index][0]) * local,
        pathPoints[index][1] + (pathPoints[index + 1][1] - pathPoints[index][1]) * local
      ];
    }
    target -= distances[index];
  }
  return pathPoints.at(-1);
}

async function readCache() {
  try { return JSON.parse(await fs.readFile(cachePath, "utf8")); }
  catch { return { version: 2, areaId: AREA_ID, lookups: {} }; }
}

async function lookup(query, cache) {
  const point = query.point;
  const address = query.address;
  const legacyKey = point ? point.map((value) => value.toFixed(6)).join(",") : null;
  const key = point ? `coordinate:${legacyKey}` : `address:${String(address).toUpperCase()}`;
  const cached = cache.lookups[key] || (legacyKey ? cache.lookups[legacyKey] : null);
  if (cached?.ok) return { ...cached, key, cached: true };
  const url = new URL("/api/denver/sweeping", APP_ORIGIN);
  if (point) {
    url.searchParams.set("latitude", point[0]);
    url.searchParams.set("longitude", point[1]);
  } else {
    url.searchParams.set("address", address);
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (response.ok) {
        const payload = await response.json();
        return cache.lookups[key] = { ok: true, ...(point ? { point } : { address }), routes: payload.routes || [] };
      }
    } catch {}
  }
  return cache.lookups[key] = { ok: false, ...(point ? { point } : { address }), routes: [] };
}

function offsetPoint(pathPoints, ratio, perpendicularMeters) {
  const point = pointAt(pathPoints, ratio);
  const before = pointAt(pathPoints, Math.max(0, ratio - 0.03));
  const after = pointAt(pathPoints, Math.min(1, ratio + 0.03));
  const north = (after[0] - before[0]) * 111000;
  const east = (after[1] - before[1]) * 111000 * Math.cos(point[0] * Math.PI / 180);
  const length = Math.hypot(east, north) || 1;
  const offsetNorth = perpendicularMeters * east / length;
  const offsetEast = -perpendicularMeters * north / length;
  return [
    point[0] + offsetNorth / 111000,
    point[1] + offsetEast / (111000 * Math.cos(point[0] * Math.PI / 180))
  ];
}

function addressQueries(block) {
  const endpoints = [block.from, block.to]
    .filter((value) => value && !/^OSM node /i.test(value))
    .flatMap((value) => String(value).split(" / "));
  return Array.from(new Set(endpoints
    .filter((value) => normalizeStreetName(value) !== normalizeStreetName(block.streetName))
    .map((value) => `${block.streetName} & ${value}, Denver, CO`)));
}

async function runPool(items, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) { const index = next++; await worker(items[index], index); }
  }));
}

function mergeRoute(routeMap, incoming) {
  if (!incoming?.id || !Array.isArray(incoming.map?.path) || incoming.map.path.length < 2) return;
  const existing = routeMap.get(incoming.id);
  if (!existing || incoming.map.path.length > (existing.map?.path?.length || 0)) routeMap.set(incoming.id, { ...existing, ...incoming });
}

async function main() {
  const [manifest, inventory, cache] = await Promise.all([
    fs.readFile(manifestPath, "utf8").then(JSON.parse),
    fs.readFile(inventoryPath, "utf8").then(JSON.parse),
    readCache()
  ]);
  cache.version = 2;
  cache.areaId = AREA_ID;
  const blocks = manifest.blocks.filter((block) => String(block.id).startsWith(`${AREA_ID}-osm-`) && !block.excluded);
  const routeMap = new Map(inventory.routes
    // Auditor-generated pink lines are unresolved candidates, not verified
    // Denver results. Mapping Approach #3 keeps them in reports, never in the
    // public route inventory.
    .filter((route) => !(
      route.dataUnavailable &&
      String(route.expectedBlockId || "").startsWith(`${AREA_ID}-osm-`) &&
      String(route.sourceNote || "").startsWith("Generated by the inventory auditor")
    ))
    .map((route) => [route.id, route]));

  const attemptsByBlock = new Map(blocks.map((block) => [block.id, []]));
  const stages = [];
  let audit = auditInventory({ routes: routeMap, blocks, generateUnavailable: false });

  async function runStage(name, buildQueries) {
    const before = new Set(audit.unexplainedGaps.map((gap) => gap.id));
    const targetBlocks = blocks.filter((block) => before.has(block.id));
    const jobs = targetBlocks.flatMap((block) => buildQueries(block).map((query) => ({ block, query })));
    let failures = 0;
    await runPool(jobs, async ({ block, query }) => {
      const result = await lookup(query, cache);
      if (!result.ok) failures += 1;
      result.routes.forEach((route) => mergeRoute(routeMap, route));
      attemptsByBlock.get(block.id).push({
        stage: name,
        ...(query.point ? { point: query.point } : { address: query.address }),
        ok: result.ok,
        cached: Boolean(result.cached),
        returnedRouteIds: result.routes.map((route) => route.id)
      });
    });
    audit = auditInventory({ routes: routeMap, blocks, generateUnavailable: false });
    const after = new Set(audit.unexplainedGaps.map((gap) => gap.id));
    stages.push({ name, candidateBlocks: targetBlocks.length, queries: jobs.length, resolvedBlocks: [...before].filter((id) => !after.has(id)).length, failures });
  }

  // Change 2: progressively spend more requests only on blocks that remain
  // unresolved. The first pass stays fast; exhaustive fallbacks are rare and
  // every successful response is cached for subsequent mapping runs.
  await runStage("midpoint", (block) => [{ point: pointAt(block.geometry, 0.5) }]);
  await runStage("near-endpoints", (block) => [0.08, 0.92].map((ratio) => ({ point: pointAt(block.geometry, ratio) })));
  await runStage("interior-points", (block) => [0.25, 0.75].map((ratio) => ({ point: pointAt(block.geometry, ratio) })));
  await runStage("nearby-offsets", (block) => [0.2, 0.5, 0.8].flatMap((ratio) => [-18, 18].map((meters) => ({ point: offsetPoint(block.geometry, ratio, meters) }))));
  await runStage("intersection-addresses", (block) => addressQueries(block).map((address) => ({ address })));

  inventory.routes = [...routeMap.values()];
  inventory.routeCount = inventory.routes.length;
  inventory.generatedAt = new Date().toISOString();
  const report = {
    version: 2, approach: "Mapping Approach #3 — Change 2", areaId: AREA_ID, generatedAt: inventory.generatedAt,
    counts: audit.report.counts,
    queriedLookups: Object.keys(cache.lookups).length,
    queriedPoints: Object.values(cache.lookups).filter((entry) => Array.isArray(entry.point)).length,
    queriedAddresses: Object.values(cache.lookups).filter((entry) => entry.address).length,
    stages,
    unresolved: audit.unexplainedGaps.map((gap) => ({
      ...gap,
      publishAsPink: false,
      status: (attemptsByBlock.get(gap.id) || []).some((attempt) => !attempt.ok) ? "automated-retry-pending" : "needs-human-review",
      automatedChecks: attemptsByBlock.get(gap.id) || []
    }))
  };
  inventory.routes = slimRoutesForPublication(inventory.routes);
  await Promise.all([
    fs.writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`),
    fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`),
    fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  ]);
  console.log(JSON.stringify({ routeCount: inventory.routeCount, ...report.counts, queriedLookups: report.queriedLookups, stages: report.stages }, null, 2));
}

if (require.main === module) {
  if (!AREA_ID) throw new Error("Usage: node scripts/map-area-approach-3.js <area-id>");
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { pointAt, offsetPoint, addressQueries };
