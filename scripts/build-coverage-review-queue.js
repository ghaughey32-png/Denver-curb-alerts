const fs = require("fs/promises");
const path = require("path");
const { auditInventory } = require("./lib/inventory-auditor.js");

const ROOT = path.join(__dirname, "..");
const APP_ORIGIN = process.env.APP_ORIGIN || "http://127.0.0.1:3000";
const OSM_PATH = process.argv[2];
const AREA_ID = process.argv[3] || "sloans-core-pilot";
const REVIEW_PATH = path.join(ROOT, "data", "coverage-review-queue.json");
const DISCOVERED_PATH = path.join(ROOT, "data", "coverage-discovered-routes.json");
const CONCURRENCY = 3;
const includedHighways = new Set(["residential", "living_street", "unclassified", "tertiary", "secondary", "primary"]);

if (!OSM_PATH) {
  console.error("Usage: node scripts/build-coverage-review-queue.js <overpass.json> [area-id]");
  process.exit(1);
}

function inside(area, { lat, lon }) {
  return lat >= area.south && lat <= area.north && lon >= area.west && lon <= area.east;
}

function pointAt(path, ratio) {
  const scaled = ratio * (path.length - 1);
  const index = Math.min(path.length - 2, Math.floor(scaled));
  const local = scaled - index;
  return [
    path[index][0] + (path[index + 1][0] - path[index][0]) * local,
    path[index][1] + (path[index + 1][1] - path[index][1]) * local
  ];
}

function buildBlocks(source, area) {
  const ways = source.elements.filter((element) =>
    element.type === "way" && includedHighways.has(element.tags?.highway) && element.tags?.name &&
    element.tags?.access !== "private" && Array.isArray(element.nodes) &&
    Array.isArray(element.geometry) && element.nodes.length === element.geometry.length &&
    element.geometry.some((point) => inside(area, point))
  );
  const nodeUse = new Map();
  for (const way of ways) for (const id of new Set(way.nodes)) nodeUse.set(id, (nodeUse.get(id) || 0) + 1);
  const blocks = [];
  for (const way of ways) {
    let start = 0;
    for (let index = 1; index < way.nodes.length; index += 1) {
      if ((nodeUse.get(way.nodes[index]) || 0) <= 1 && index !== way.nodes.length - 1) continue;
      const geometry = way.geometry.slice(start, index + 1).map(({ lat, lon }) => [lat, lon]);
      const midpoint = geometry[Math.floor(geometry.length / 2)];
      if (geometry.length >= 2 && inside(area, { lat: midpoint[0], lon: midpoint[1] })) {
        blocks.push({
          id: `candidate-${way.id}-${way.nodes[start]}-${way.nodes[index]}`,
          streetName: way.tags.name,
          from: `OSM node ${way.nodes[start]}`,
          to: `OSM node ${way.nodes[index]}`,
          geometry,
          osm: { wayId: way.id, highway: way.tags.highway }
        });
      }
      start = index;
    }
  }
  return blocks;
}

async function queryPoint(point) {
  const url = new URL("/api/denver/sweeping", APP_ORIGIN);
  url.searchParams.set("latitude", point[0]);
  url.searchParams.set("longitude", point[1]);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const result = await response.json();
        return { point, ok: true, attempt, routes: Array.isArray(result.routes) ? result.routes : [] };
      }
      if (attempt === 3) return { point, ok: false, attempt, status: response.status, routes: [] };
    } catch (error) {
      if (attempt === 3) return { point, ok: false, attempt, error: error.message, routes: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return results;
}

async function main() {
  const [source, areasFile, inventory] = await Promise.all([
    fs.readFile(OSM_PATH, "utf8").then(JSON.parse),
    fs.readFile(path.join(ROOT, "data", "coverage-pilot-areas.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(ROOT, "public", "denver-west-routes.json"), "utf8").then(JSON.parse)
  ]);
  const area = areasFile.areas.find((entry) => entry.id === AREA_ID);
  if (!area) throw new Error(`Unknown pilot area: ${AREA_ID}`);

  const blocks = buildBlocks(source, area);
  const initial = auditInventory({ routes: inventory.routes, blocks, generateUnavailable: false });
  const candidates = initial.unexplainedGaps.map((gap) => blocks.find((block) => block.id === gap.id));
  console.log(`Pilot has ${blocks.length} expected blocks; retrying ${candidates.length} candidate gaps.`);

  const attempts = await runPool(candidates, async (block) => {
    const points = [0.08, 0.25, 0.5, 0.75, 0.92].map((ratio) => pointAt(block.geometry, ratio));
    const lookups = [];
    for (const point of points) {
      lookups.push(await queryPoint(point));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { blockId: block.id, lookups };
  });
  const discoveredMap = new Map();
  for (const attempt of attempts) for (const lookup of attempt.lookups) {
    for (const route of lookup.routes) if (route?.id != null && route.map?.path?.length >= 2) discoveredMap.set(route.id, route);
  }
  const combinedRoutes = [...inventory.routes, ...discoveredMap.values()];
  const finalAudit = auditInventory({ routes: combinedRoutes, blocks, generateUnavailable: false });
  const attemptsByBlock = new Map(attempts.map((attempt) => [attempt.blockId, attempt]));
  const unresolved = finalAudit.unexplainedGaps.map((gap) => {
    const block = blocks.find((entry) => entry.id === gap.id);
    const attempt = attemptsByBlock.get(gap.id);
    return {
      id: block.id,
      areaId: area.id,
      status: attempt.lookups.every((lookup) => lookup.ok) ? "needs-human-review" : "automated-retry-pending",
      publishAsPink: false,
      streetName: block.streetName,
      from: block.from,
      to: block.to,
      geometry: block.geometry,
      osm: block.osm,
      automatedChecks: attempt.lookups.map((lookup) => ({
        point: lookup.point,
        ok: lookup.ok,
        returnedRouteIds: lookup.routes.map((route) => route.id)
      })),
      reviewDecision: null
    };
  });
  const queue = unresolved.filter((item) => item.status === "needs-human-review");
  const retryPending = unresolved.filter((item) => item.status === "automated-retry-pending");
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    area,
    summary: {
      expectedBlocks: blocks.length,
      initiallyCovered: initial.report.counts.scheduled,
      candidatesRetried: candidates.length,
      resolvedByRetries: candidates.length - unresolved.length,
      needsHumanReview: queue.length,
      automatedRetryPending: retryPending.length,
      lookupFailures: attempts.flatMap((attempt) => attempt.lookups).filter((lookup) => !lookup.ok).length
    },
    items: queue,
    retryPending
  };
  await fs.writeFile(REVIEW_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(DISCOVERED_PATH, `${JSON.stringify({ generatedAt: payload.generatedAt, routes: [...discoveredMap.values()] }, null, 2)}\n`);
  console.log(JSON.stringify(payload.summary, null, 2));
  if (payload.summary.lookupFailures) process.exitCode = 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
